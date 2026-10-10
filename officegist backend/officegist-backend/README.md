# OfficeGist API (V1)

Node 20+, Express, PostgreSQL 14+. Four runtime dependencies: `express`, `express-rate-limit`, `pg`, `zod`. Password hashing and tokens use Node's built-in `crypto`.

## Run it

```bash
cp .env.example .env            # set DATABASE_URL, IP_HASH_SECRET, APP_ORIGIN
npm install
export $(grep -v '^#' .env | xargs)
npm run migrate:demo            # schema + fictional demo companies (use `npm run migrate` for schema only)
npm test                        # 15 unit tests (moderation rules, crypto)
npm start
```

Make your first admin: register through the API, then
`UPDATE users SET role = 'ADMIN' WHERE email = 'you@example.com';`

First smoke test after `npm start` (cookies are kept in `jar`):

```bash
H='Content-Type: application/json'
curl -s localhost:4000/api/companies/trending
curl -s -c jar -H "$H" -d '{"email":"a@b.com","password":"longenough1"}' localhost:4000/api/auth/register
curl -s -b jar -H "$H" -d '{"category":"CAREER_ADVICE","body":"Ask about shift pay before signing anything."}' localhost:4000/api/gist
```

The gist comes back `PENDING` (a human approves it at launch). Approve it from the admin queue, then it appears in `GET /api/gist`.

## Endpoints

All under `/api`. Writes must send `Content-Type: application/json`. Auth is an HttpOnly session cookie.

| Area | Endpoint | Notes |
|---|---|---|
| Search | `GET /search?q=` | companies (name, industry, city) + job titles. Autocomplete-sized. |
| Companies | `GET /companies`, `/companies/trending`, `/companies/:slug` | profile includes `ratings`, `recommend_pct`, `seo` (title, description, canonical, JSON-LD) |
| | `GET /companies/:slug/reviews` `?sort=recent\|helpful\|high\|low&employment=` | |
| | `GET /companies/:slug/interviews` | includes `commonQuestions` |
| | `GET /companies/:slug/salaries` | only titles with enough reports |
| Salaries | `GET /salaries`, `/salaries/:titleSlug` | median, typical range (p25 to p75), report count, last updated |
| Interviews | `GET /interviews?role=` | |
| Gist | `GET /gist?category=&cursor=`, `GET /gist/:id/comments` | keyset pagination |
| SEO | `GET /sitemap.xml` | proxy this to `/sitemap.xml` on the web domain |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, `GET /me`, `DELETE /me` | |
| Dashboard | `GET /me/contributions`, `/me/saved`, `/me/notifications`, `/me/verifications` | |
| Contribute | `POST /reviews`, `/salaries`, `/interviews`, `/gist`, `/gist/:id/comments` | every one goes through moderation |
| | `PATCH /contributions/:type/:id` | author fixes a `NEEDS_EDIT` item; pipeline re-runs |
| Engage | `POST /reviews/:id/helpful`, `/interviews/:id/helpful`, `/gist/:id/like` | toggles |
| | `PUT/DELETE /me/saved/companies/:slug`, `/me/saved/gists/:id` | |
| Reports | `POST /reports` | reasons per spec |
| Verify | `POST /verifications/work-email`, `/verifications/confirm`, `/verifications/email/resend` | |
| Employers | `POST /companies/:slug/claim`, `PATCH /companies/:slug`, `POST /reviews/:id/response` | no endpoint exists to edit or delete a review |
| Admin | `GET /admin/stats`, `/admin/moderation`, `/admin/reports`, `/admin/claims`, `/admin/audit` | |
| | `POST /admin/moderation/:id/decision`, `/admin/reports/resolve`, `/admin/claims/:id/decision`, `/admin/users/:id/status` | each writes `admin_actions` |

## How privacy is enforced (not just promised)

- **Public reads use `v_public_*` views** that contain no `user_id`, email, IP, flags or risk, and only `APPROVED` rows. A bug in a public endpoint cannot leak what the view does not select.
- **Email, phone, IPs live only in private tables.** IPs are stored as an HMAC (`ip_hash`) for abuse checks; raw IPs are never stored.
- **Work-email verification stores only the domain**, not the address.
- **Salary figures stay hidden until `MIN_SALARY_REPORTS` (default 5) approved reports exist.** Below that, the API returns the count and `insufficientData: true`.
- **Deleting an account** removes private data and sessions; contributions stay, with `user_id` set to NULL, so they show as anonymous.
- **`admin_actions` is append-only** (trigger blocks UPDATE, DELETE, TRUNCATE).

## Moderation pipeline

Every contribution is scanned (`src/lib/moderation.js`), then routed:

| Result | Triggers | Status |
|---|---|---|
| HIGH | threats, hate speech, doxxing, serious allegations, criminal allegation about a named person | `ESCALATED` (human required) |
| HIGH | phone, email, street address | `NEEDS_EDIT` with exact instructions; author can fix and resubmit |
| MEDIUM | profanity, links, spam, named person, criminal allegation, duplicate text, burst or shared-network activity, salary outliers | `PENDING` |
| LOW | nothing flagged | `PENDING` by default. `AUTO_APPROVE_LOW=true` publishes it if the account is 24h+ old |

At launch every item is human-reviewed. Turn on `AUTO_APPROVE_LOW` once you trust the rules and have moderator capacity.

**Anti-suppression:** a company cannot remove a negative review. Reports never delete; one report hides content pending review only for `PERSONAL_INFORMATION` or `THREAT`, and never from a company rep. Everything else needs 3 distinct non-rep reporters. Employer responses are moderated too.

## Known limits (read before launch)

- **Not run against a live database in the build environment** (no Postgres or network). 15 unit tests pass and every file parses, and I checked that all 30 spec entities exist with foreign keys in a valid order, but the SQL and routes need a first real run. Expect to fix a few small things.
- Moderation rules are regex heuristics: no ML, and the `HATE_TERMS` and `EXTRA_PROFANITY` lists ship empty. Nigerian Pidgin and Yoruba/Igbo/Hausa terms need a vetted list from someone who can judge them.
- Shared-IP detection is weak on mobile carrier networks; it only routes to a human, never rejects.
- **Defamation risk is a legal question, not a regex.** The pipeline surfaces candidates; get a Nigerian media/defamation lawyer to set the escalation policy and takedown process.
- Duplicate-question matching on interviews is exact (normalised text). Fuzzy matching is a later improvement. Job titles are not yet normalised ("HR Officer" vs "Human Resources Officer" are different slugs).
- Email is a stub (`src/lib/mailer.js` logs in dev, throws in production until you plug in a provider).
- Not built: password reset, social login, evidence file upload (signed URLs), user suggestion of new companies, admin user search, `jobs` endpoints, billing.
- The frontend is a separate app. For SEO it needs server-side rendering (e.g. Next.js) calling this API; use `seo` in the company response for `<head>` and JSON-LD.
