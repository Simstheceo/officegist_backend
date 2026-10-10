-- OfficeGist V1 schema. PostgreSQL 14+.
-- Design rules:
--   * Identity is private by construction: public reads go through v_public_* views that never select user_id, email or IPs.
--   * Content rows keep user_id with ON DELETE SET NULL, so deleting an account anonymises its contributions (NDPA erasure) instead of erasing data others rely on.
--   * Every contribution has status + risk + flags, and a row in moderation_queue. Only APPROVED rows are visible publicly.
--   * admin_actions is append-only (enforced by trigger).
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- enums ----------
CREATE TYPE moderation_status AS ENUM ('PENDING','APPROVED','REJECTED','NEEDS_EDIT','ESCALATED');
CREATE TYPE risk_level        AS ENUM ('LOW','MEDIUM','HIGH');
CREATE TYPE user_role         AS ENUM ('USER','COMPANY_REP','MODERATOR','ADMIN');
CREATE TYPE employment_status AS ENUM ('CURRENT','FORMER');
CREATE TYPE rating_dimension  AS ENUM ('MANAGEMENT','COMPENSATION','CULTURE','WORK_LIFE_BALANCE','CAREER_GROWTH','JOB_SECURITY','BENEFITS');
CREATE TYPE entity_type       AS ENUM ('REVIEW','GIST','GIST_COMMENT','SALARY_REPORT','INTERVIEW','REVIEW_RESPONSE');
CREATE TYPE report_reason     AS ENUM ('HARASSMENT','PERSONAL_INFORMATION','FALSE_INFORMATION','SPAM','THREAT','HATE_SPEECH','DEFAMATION','OTHER');
CREATE TYPE verification_status AS ENUM ('PENDING','VERIFIED','REJECTED');
CREATE TYPE claim_status      AS ENUM ('PENDING','APPROVED','REJECTED');
CREATE TYPE gist_category     AS ENUM ('SALARY','MANAGEMENT','OFFICE_POLITICS','INTERVIEW','PROMOTION','WORK_LIFE','TOXIC_WORKPLACE','CAREER_ADVICE','FUNNY','REMOTE_WORK','OTHER');
CREATE TYPE experience_level  AS ENUM ('ENTRY','MID','SENIOR','LEAD','EXECUTIVE');
CREATE TYPE employment_type   AS ENUM ('FULL_TIME','PART_TIME','CONTRACT','INTERNSHIP','NYSC');
CREATE TYPE difficulty_level  AS ENUM ('EASY','MEDIUM','HARD');
CREATE TYPE interview_outcome AS ENUM ('OFFER','REJECTED','NO_RESPONSE','DECLINED_OFFER');

-- ---------- shared trigger functions ----------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

-- Adds +1/-1 to a counter column on a parent row when a vote/like row is inserted/deleted.
-- TG_ARGV: parent table, counter column, fk column on the vote table.
CREATE FUNCTION bump_counter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE delta int; pid uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN delta := 1;  pid := (to_jsonb(NEW) ->> TG_ARGV[2])::uuid;
  ELSE                     delta := -1; pid := (to_jsonb(OLD) ->> TG_ARGV[2])::uuid;
  END IF;
  EXECUTE format('UPDATE %I SET %I = %I + $1 WHERE id = $2', TG_ARGV[0], TG_ARGV[1], TG_ARGV[1]) USING delta, pid;
  RETURN NULL;
END $$;

-- ---------- identity ----------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text,                       -- NULL allowed for future social-only accounts
  role user_role NOT NULL DEFAULT 'USER',
  anon_number int NOT NULL UNIQUE,          -- public handle: "Anonymous Employee #4821"
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION set_anon_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF NEW.anon_number IS NULL THEN
    LOOP
      n := 1000 + floor(random() * 99000)::int;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM users WHERE anon_number = n);
    END LOOP;
    NEW.anon_number := n;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_anon_number BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION set_anon_number();

-- Private profile data. Nothing here is ever selected by a public query.
CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name text, phone text, state text, job_title text, years_experience smallint,
  notify_email boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Opaque, revocable sessions. Only the SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  ip_hash char(64),                         -- HMAC of IP, never the raw IP
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_ip_idx ON sessions(ip_hash);

-- ---------- companies ----------
CREATE TABLE industries (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE
);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  industry_id int REFERENCES industries(id),
  description text, website text, logo_url text, employee_band text,
  verified_at timestamptz,                  -- set when a claim is approved
  is_demo boolean NOT NULL DEFAULT false,   -- fictional seed data, labelled in the UI
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','HIDDEN')),
  -- cached aggregates, maintained by trigger on reviews
  review_count int NOT NULL DEFAULT 0,
  avg_rating numeric(3,2),
  recommend_pct smallint,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX companies_name_trgm ON companies USING gin (name gin_trgm_ops);
CREATE INDEX companies_industry_idx ON companies(industry_id);

CREATE TABLE company_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  city text NOT NULL, state text, country char(2) NOT NULL DEFAULT 'NG',
  is_hq boolean NOT NULL DEFAULT false
);
CREATE INDEX company_locations_company_idx ON company_locations(company_id);
CREATE INDEX company_locations_city_trgm ON company_locations USING gin (city gin_trgm_ops);

-- Approved claimants. Reps can respond and edit the profile; they cannot delete reviews (no such code path or FK cascade).
CREATE TABLE company_members (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE company_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_email_domain text NOT NULL, role_title text NOT NULL, evidence_note text,
  evidence_ref text,                        -- private storage key for uploaded documents
  status claim_status NOT NULL DEFAULT 'PENDING',
  reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX company_claims_one_pending ON company_claims(company_id, user_id) WHERE status = 'PENDING';

CREATE TABLE user_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('EMAIL','WORK_EMAIL','DOCUMENT')),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  work_email_domain text,                   -- the full work email is deliberately not stored
  token_hash char(64), evidence_ref text,
  status verification_status NOT NULL DEFAULT 'PENDING',
  reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz,
  expires_at timestamptz, verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_verifications_token_idx ON user_verifications(token_hash);
CREATE INDEX user_verifications_user_idx ON user_verifications(user_id, company_id);

-- ---------- reviews ----------
CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  employment employment_status NOT NULL,
  job_title text NOT NULL, department text, location text NOT NULL,
  tenure_months smallint NOT NULL CHECK (tenure_months BETWEEN 0 AND 600),
  headline text,
  body text NOT NULL CHECK (char_length(body) BETWEEN 50 AND 4000),
  overall_rating numeric(3,2) NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
  would_recommend boolean NOT NULL,
  would_work_again boolean NOT NULL,
  verified_experience boolean NOT NULL DEFAULT false,
  helpful_count int NOT NULL DEFAULT 0,
  status moderation_status NOT NULL DEFAULT 'PENDING',
  risk risk_level NOT NULL DEFAULT 'LOW',
  flags text[] NOT NULL DEFAULT '{}',
  body_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reviews_one_per_user_company ON reviews(user_id, company_id) WHERE status <> 'REJECTED';
CREATE INDEX reviews_company_pub_idx ON reviews(company_id, published_at DESC) WHERE status = 'APPROVED';
CREATE INDEX reviews_hash_idx ON reviews(body_hash);

CREATE TABLE review_ratings (
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  dimension rating_dimension NOT NULL,
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  PRIMARY KEY (review_id, dimension)
);

CREATE TABLE review_votes (   -- "Helpful"
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, user_id)
);
CREATE TRIGGER review_votes_count AFTER INSERT OR DELETE ON review_votes
  FOR EACH ROW EXECUTE FUNCTION bump_counter('reviews','helpful_count','review_id');

CREATE TABLE review_responses (  -- employer replies; moderated like any other content
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 2000),
  status moderation_status NOT NULL DEFAULT 'PENDING',
  risk risk_level NOT NULL DEFAULT 'LOW',
  flags text[] NOT NULL DEFAULT '{}',
  body_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_responses_review_idx ON review_responses(review_id) WHERE status = 'APPROVED';

-- Keep companies.review_count / avg_rating / recommend_pct in step with approved reviews.
CREATE FUNCTION refresh_company_stats() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN cid := OLD.company_id; ELSE cid := NEW.company_id; END IF;
  UPDATE companies c SET review_count = s.n, avg_rating = s.avg_r, recommend_pct = s.rec
  FROM (SELECT count(*)::int AS n,
               round(avg(overall_rating), 2) AS avg_r,
               round(100.0 * avg(would_recommend::int))::smallint AS rec
        FROM reviews WHERE company_id = cid AND status = 'APPROVED') s
  WHERE c.id = cid;
  RETURN NULL;
END $$;
CREATE TRIGGER reviews_company_stats AFTER INSERT OR DELETE OR UPDATE OF status, overall_rating, would_recommend ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_company_stats();

-- ---------- salaries ----------
CREATE TABLE salary_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  job_title text NOT NULL, job_title_slug text NOT NULL, department text, location text NOT NULL,
  experience_level experience_level NOT NULL,
  employment_type employment_type NOT NULL,
  period text NOT NULL CHECK (period IN ('MONTHLY','ANNUAL')),
  base_salary numeric(14,2) NOT NULL CHECK (base_salary > 0),
  allowances numeric(14,2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),   -- same period as base
  bonus numeric(14,2) NOT NULL DEFAULT 0 CHECK (bonus >= 0),             -- annual total
  base_monthly numeric(14,2) GENERATED ALWAYS AS (CASE WHEN period = 'ANNUAL' THEN base_salary / 12 ELSE base_salary END) STORED,
  year smallint NOT NULL CHECK (year BETWEEN 2015 AND 2100),
  verified_experience boolean NOT NULL DEFAULT false,
  status moderation_status NOT NULL DEFAULT 'PENDING',
  risk risk_level NOT NULL DEFAULT 'LOW',
  flags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX salary_one_per_user_title_year ON salary_reports(user_id, company_id, job_title_slug, year) WHERE status <> 'REJECTED';
CREATE INDEX salary_title_idx ON salary_reports(job_title_slug) WHERE status = 'APPROVED';
CREATE INDEX salary_company_idx ON salary_reports(company_id) WHERE status = 'APPROVED';

CREATE TABLE salary_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salary_report_id uuid NOT NULL REFERENCES salary_reports(id) ON DELETE CASCADE,
  evidence_ref text NOT NULL,               -- private storage key (payslip etc.), never public
  status verification_status NOT NULL DEFAULT 'PENDING',
  reviewed_by uuid REFERENCES users(id), reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- interviews ----------
CREATE TABLE interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  role text NOT NULL, role_slug text NOT NULL, location text NOT NULL,
  stage_reached text NOT NULL,
  difficulty difficulty_level NOT NULL,
  stages_count smallint NOT NULL CHECK (stages_count BETWEEN 1 AND 10),
  assessment_type text NOT NULL CHECK (assessment_type IN ('NONE','APTITUDE_TEST','TECHNICAL_TEST','CASE_STUDY','TAKE_HOME','PRESENTATION','GROUP_EXERCISE','OTHER')),
  outcome interview_outcome NOT NULL,
  experience text NOT NULL CHECK (char_length(experience) BETWEEN 30 AND 3000),
  interviewed_on date,
  helpful_count int NOT NULL DEFAULT 0,
  status moderation_status NOT NULL DEFAULT 'PENDING',
  risk risk_level NOT NULL DEFAULT 'LOW',
  flags text[] NOT NULL DEFAULT '{}',
  body_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX interviews_company_idx ON interviews(company_id, published_at DESC) WHERE status = 'APPROVED';
CREATE INDEX interviews_role_idx ON interviews(role_slug) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX interviews_hash_user ON interviews(user_id, body_hash) WHERE status <> 'REJECTED';

CREATE TABLE interview_questions (   -- inherits visibility from its interview
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (char_length(question) BETWEEN 5 AND 300),
  question_hash char(64) NOT NULL
);
CREATE INDEX interview_questions_interview_idx ON interview_questions(interview_id);
CREATE INDEX interview_questions_hash_idx ON interview_questions(question_hash);

CREATE TABLE interview_votes (
  interview_id uuid NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (interview_id, user_id)
);
CREATE TRIGGER interview_votes_count AFTER INSERT OR DELETE ON interview_votes
  FOR EACH ROW EXECUTE FUNCTION bump_counter('interviews','helpful_count','interview_id');

-- ---------- gist ----------
CREATE TABLE gists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  category gist_category NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 10 AND 1000),
  like_count int NOT NULL DEFAULT 0,
  comment_count int NOT NULL DEFAULT 0,
  status moderation_status NOT NULL DEFAULT 'PENDING',
  risk risk_level NOT NULL DEFAULT 'LOW',
  flags text[] NOT NULL DEFAULT '{}',
  body_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gists_feed_idx ON gists(published_at DESC, id DESC) WHERE status = 'APPROVED';
CREATE INDEX gists_category_idx ON gists(category, published_at DESC) WHERE status = 'APPROVED';
CREATE INDEX gists_hash_idx ON gists(body_hash);

CREATE TABLE gist_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gist_id uuid NOT NULL REFERENCES gists(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 2 AND 500),
  status moderation_status NOT NULL DEFAULT 'PENDING',
  risk risk_level NOT NULL DEFAULT 'LOW',
  flags text[] NOT NULL DEFAULT '{}',
  body_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gist_comments_gist_idx ON gist_comments(gist_id, published_at) WHERE status = 'APPROVED';

CREATE FUNCTION recount_gist_comments() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN gid := OLD.gist_id; ELSE gid := NEW.gist_id; END IF;
  UPDATE gists SET comment_count = (SELECT count(*) FROM gist_comments WHERE gist_id = gid AND status = 'APPROVED') WHERE id = gid;
  RETURN NULL;
END $$;
CREATE TRIGGER gist_comments_count AFTER INSERT OR DELETE OR UPDATE OF status ON gist_comments
  FOR EACH ROW EXECUTE FUNCTION recount_gist_comments();

CREATE TABLE gist_likes (
  gist_id uuid NOT NULL REFERENCES gists(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gist_id, user_id)
);
CREATE TRIGGER gist_likes_count AFTER INSERT OR DELETE ON gist_likes
  FOR EACH ROW EXECUTE FUNCTION bump_counter('gists','like_count','gist_id');

-- Dashboard: saved items
CREATE TABLE saved_companies (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, company_id)
);
CREATE TABLE saved_gists (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gist_id uuid NOT NULL REFERENCES gists(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, gist_id)
);

-- ---------- jobs (table only in V1; no marketplace) ----------
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title text NOT NULL, location text, description text, apply_url text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPEN','CLOSED')),
  posted_at timestamptz, expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE job_views (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  viewed_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- notifications ----------
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

-- ---------- reports & moderation ----------
CREATE TABLE reports (        -- one table for every reportable thing
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type entity_type NOT NULL, entity_id uuid NOT NULL,
  reason report_reason NOT NULL, details text CHECK (char_length(details) <= 1000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACTIONED','DISMISSED')),
  handled_by uuid REFERENCES users(id), handled_at timestamptz, handler_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_one_per_reporter UNIQUE (reporter_id, entity_type, entity_id)
);
CREATE INDEX reports_entity_idx ON reports(entity_type, entity_id);
CREATE INDEX reports_open_idx ON reports(created_at) WHERE status = 'OPEN';
-- Names from the original spec, kept as views over the single table.
CREATE VIEW review_reports AS SELECT * FROM reports WHERE entity_type = 'REVIEW';
CREATE VIEW gist_reports   AS SELECT * FROM reports WHERE entity_type = 'GIST';

-- entity_id is polymorphic (no FK). All writes go through the API's ENT whitelist.
CREATE TABLE moderation_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type entity_type NOT NULL, entity_id uuid NOT NULL,
  status moderation_status NOT NULL, risk risk_level NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  auto boolean NOT NULL DEFAULT false,      -- true when the automated pipeline decided
  assigned_to uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id), decided_at timestamptz, note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_one_per_entity UNIQUE (entity_type, entity_id)
);
CREATE INDEX moderation_queue_work_idx ON moderation_queue(status, risk, created_at);

CREATE TABLE admin_actions (  -- immutable audit trail
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL, entity_type text, entity_id text,
  before_state jsonb, after_state jsonb, note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER admin_actions_immutable BEFORE UPDATE OR DELETE ON admin_actions FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER admin_actions_no_truncate BEFORE TRUNCATE ON admin_actions FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- ---------- billing placeholders (not used in V1) ----------
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'FREE', status text NOT NULL DEFAULT 'ACTIVE',
  provider text, provider_ref text, current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  amount_kobo bigint NOT NULL CHECK (amount_kobo >= 0), currency char(3) NOT NULL DEFAULT 'NGN',
  provider text NOT NULL, provider_ref text NOT NULL UNIQUE,
  status text NOT NULL, paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  anon_id text, event text NOT NULL, props jsonb NOT NULL DEFAULT '{}',
  ip_hash char(64), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_idx ON analytics_events(event, created_at);
CREATE INDEX analytics_events_user_idx ON analytics_events(user_id, created_at);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','user_profiles','companies','reviews','review_responses','salary_reports',
                           'interviews','gists','gist_comments','jobs','moderation_queue','subscriptions']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t || '_updated', t);
  END LOOP;
END $$;

-- ---------- PUBLIC VIEWS: the only things public endpoints read ----------
-- No user_id, email, IP, flags or risk. Only APPROVED rows. A deleted account shows as anon_number NULL.
CREATE VIEW v_public_reviews AS
SELECT r.id, r.company_id, u.anon_number, r.employment, r.job_title, r.department, r.location, r.tenure_months,
       r.headline, r.body, r.overall_rating, r.would_recommend, r.would_work_again, r.verified_experience,
       r.helpful_count, r.published_at,
       (SELECT jsonb_object_agg(rr.dimension, rr.score) FROM review_ratings rr WHERE rr.review_id = r.id) AS ratings,
       (SELECT jsonb_agg(jsonb_build_object('body', x.body, 'published_at', x.published_at) ORDER BY x.published_at)
          FROM review_responses x WHERE x.review_id = r.id AND x.status = 'APPROVED') AS responses
FROM reviews r LEFT JOIN users u ON u.id = r.user_id
WHERE r.status = 'APPROVED';

CREATE VIEW v_public_gists AS
SELECT g.id, u.anon_number, g.category, g.body, g.like_count, g.comment_count, g.published_at,
       c.slug AS company_slug, c.name AS company_name
FROM gists g LEFT JOIN users u ON u.id = g.user_id LEFT JOIN companies c ON c.id = g.company_id
WHERE g.status = 'APPROVED';

CREATE VIEW v_public_gist_comments AS
SELECT m.id, m.gist_id, u.anon_number, m.body, m.published_at
FROM gist_comments m LEFT JOIN users u ON u.id = m.user_id
WHERE m.status = 'APPROVED';

CREATE VIEW v_public_interviews AS
SELECT i.id, i.company_id, u.anon_number, i.role, i.role_slug, i.location, i.stage_reached, i.difficulty, i.stages_count,
       i.assessment_type, i.outcome, i.experience, i.interviewed_on, i.helpful_count, i.published_at,
       (SELECT coalesce(jsonb_agg(q.question), '[]'::jsonb) FROM interview_questions q WHERE q.interview_id = i.id) AS questions
FROM interviews i LEFT JOIN users u ON u.id = i.user_id
WHERE i.status = 'APPROVED';

COMMIT;
