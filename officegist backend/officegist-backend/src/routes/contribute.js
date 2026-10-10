import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { requireAuth, dailyCap } from '../auth.js';
import { h, HttpError, clean, norm, slugify } from '../http.js';
import { sha256 } from '../lib/crypto.js';
import { submit, resubmit, ENT, notify } from '../lib/submit.js';

export const contrib = Router();

// Voting and saving: 120 actions per hour per user.
const actionLimit = rateLimit({ windowMs: 3600e3, limit: 120, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false, validate: false });

const text = (min, max) => z.string().transform(clean).pipe(z.string().min(min).max(max));
const DIMS = ['MANAGEMENT', 'COMPENSATION', 'CULTURE', 'WORK_LIFE_BALANCE', 'CAREER_GROWTH', 'JOB_SECURITY', 'BENEFITS'];
const uuid = z.string().uuid();
// Hash only long-enough text so short replies like "Same here" are not treated as copy-paste.
const hashOf = (s) => (norm(s).length >= 40 ? sha256(norm(s)) : null);

async function companyBySlug(c, slug) {
  const { rows: [co] } = await c.query(`SELECT id FROM companies WHERE slug = $1 AND status = 'ACTIVE'`, [slug]);
  if (!co) throw new HttpError(404, 'Company not found.');
  return co;
}
const isVerifiedFor = (userId, companyId) => `EXISTS (SELECT 1 FROM user_verifications v WHERE v.user_id = ${userId} AND v.company_id = ${companyId}
  AND v.kind IN ('WORK_EMAIL','DOCUMENT') AND v.status = 'VERIFIED')`;

// ---------- reviews ----------
const reviewSchema = z.object({
  companySlug: z.string(),
  employment: z.enum(['CURRENT', 'FORMER']),
  jobTitle: text(2, 80), department: text(2, 80).optional(), location: text(2, 80),
  tenureMonths: z.number().int().min(0).max(600),
  ratings: z.object(Object.fromEntries(DIMS.map((d) => [d, z.number().int().min(1).max(5)]))),
  headline: text(0, 120).optional(),
  body: text(50, 4000),            // "What's something a prospective employee should know before joining?"
  wouldRecommend: z.boolean(), wouldWorkAgain: z.boolean(),
});

contrib.post('/reviews', requireAuth, dailyCap('reviews', 3), h(async (req, res) => {
  const d = reviewSchema.parse(req.body);
  const out = await tx(async (c) => {
    const co = await companyBySlug(c, d.companySlug);
    const scores = Object.values(d.ratings);
    const overall = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
    const r = await submit(c, {
      type: 'REVIEW', user: req.user, companyId: co.id, hash: hashOf(d.body),
      texts: [d.headline, d.body, d.jobTitle, d.department],
      insert: async (m) => {
        const { rows: [row] } = await c.query(
          `INSERT INTO reviews(company_id, user_id, employment, job_title, department, location, tenure_months, headline, body,
                               overall_rating, would_recommend, would_work_again, verified_experience, status, risk, flags, body_hash, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, ${isVerifiedFor('$2', '$1')}, $13,$14,$15,$16, CASE WHEN $13::moderation_status = 'APPROVED' THEN now() END)
           RETURNING id`,
          [co.id, req.user.id, d.employment, d.jobTitle, d.department ?? null, d.location, d.tenureMonths, d.headline || null, d.body,
           overall, d.wouldRecommend, d.wouldWorkAgain, m.status, m.risk, m.flags, hashOf(d.body)]);
        await c.query(`INSERT INTO review_ratings(review_id, dimension, score) SELECT $1::uuid, k::rating_dimension, v::smallint FROM jsonb_each_text($2::jsonb) AS t(k, v)`, [row.id, JSON.stringify(d.ratings)]);
        return row;
      },
    });
    return r;
  });
  res.status(201).json(out);
}));

// ---------- salaries ----------
const year = new Date().getFullYear();
const salarySchema = z.object({
  companySlug: z.string(), jobTitle: text(2, 80), department: text(2, 80).optional(), location: text(2, 80),
  experienceLevel: z.enum(['ENTRY', 'MID', 'SENIOR', 'LEAD', 'EXECUTIVE']),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'NYSC']),
  period: z.enum(['MONTHLY', 'ANNUAL']),
  baseSalary: z.number().positive(), allowances: z.number().min(0).default(0), bonus: z.number().min(0).default(0),
  year: z.number().int().min(2015).max(year),
}).superRefine((v, ctx) => {
  const [lo, hi] = v.period === 'MONTHLY' ? [5_000, 50_000_000] : [60_000, 600_000_000];
  if (v.baseSalary < lo || v.baseSalary > hi)
    ctx.addIssue({ code: 'custom', path: ['baseSalary'], message: `For a ${v.period.toLowerCase()} salary, enter an amount in naira between ${lo.toLocaleString('en-NG')} and ${hi.toLocaleString('en-NG')}.` });
});

contrib.post('/salaries', requireAuth, dailyCap('salary_reports', 5), h(async (req, res) => {
  const d = salarySchema.parse(req.body);
  const slug = slugify(d.jobTitle);
  if (!slug) throw new HttpError(422, 'Enter a valid job title.');
  const monthly = d.period === 'ANNUAL' ? d.baseSalary / 12 : d.baseSalary;
  const out = await tx(async (c) => {
    const co = await companyBySlug(c, d.companySlug);
    // Outlier check: 10x above or below the existing median for this title (needs >= 5 reports to judge).
    const { rows: [m] } = await c.query(
      `SELECT count(*)::int AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY base_monthly::float8) AS med
         FROM salary_reports WHERE job_title_slug = $1 AND status = 'APPROVED'`, [slug]);
    const outlier = m.n >= 5 && (monthly > m.med * 10 || monthly < m.med / 10);
    return submit(c, {
      type: 'SALARY_REPORT', user: req.user, companyId: co.id, texts: [d.jobTitle, d.department], extraFlags: outlier ? ['SALARY_OUTLIER'] : [],
      insert: async (mod) => {
        const { rows: [row] } = await c.query(
          `INSERT INTO salary_reports(company_id, user_id, job_title, job_title_slug, department, location, experience_level, employment_type,
                                      period, base_salary, allowances, bonus, year, verified_experience, status, risk, flags, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, ${isVerifiedFor('$2', '$1')}, $14,$15,$16, CASE WHEN $14::moderation_status = 'APPROVED' THEN now() END)
           RETURNING id`,
          [co.id, req.user.id, d.jobTitle, slug, d.department ?? null, d.location, d.experienceLevel, d.employmentType,
           d.period, d.baseSalary, d.allowances, d.bonus, d.year, mod.status, mod.risk, mod.flags]);
        return row;
      },
    });
  });
  res.status(201).json(out);
}));

// ---------- interviews ----------
const interviewSchema = z.object({
  companySlug: z.string(), role: text(2, 80), location: text(2, 80), stageReached: text(2, 80),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']), stagesCount: z.number().int().min(1).max(10),
  assessmentType: z.enum(['NONE', 'APTITUDE_TEST', 'TECHNICAL_TEST', 'CASE_STUDY', 'TAKE_HOME', 'PRESENTATION', 'GROUP_EXERCISE', 'OTHER']),
  outcome: z.enum(['OFFER', 'REJECTED', 'NO_RESPONSE', 'DECLINED_OFFER']),
  experience: text(30, 3000),
  questions: z.array(text(5, 300)).max(10).default([]),
  interviewedOn: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

contrib.post('/interviews', requireAuth, dailyCap('interviews', 5), h(async (req, res) => {
  const d = interviewSchema.parse(req.body);
  const out = await tx(async (c) => {
    const co = await companyBySlug(c, d.companySlug);
    return submit(c, {
      type: 'INTERVIEW', user: req.user, companyId: co.id, hash: hashOf(d.experience),
      texts: [d.role, d.experience, d.stageReached, ...d.questions],
      insert: async (m) => {
        const { rows: [row] } = await c.query(
          `INSERT INTO interviews(company_id, user_id, role, role_slug, location, stage_reached, difficulty, stages_count, assessment_type,
                                  outcome, experience, interviewed_on, status, risk, flags, body_hash, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, CASE WHEN $13::moderation_status = 'APPROVED' THEN now() END)
           RETURNING id`,
          [co.id, req.user.id, d.role, slugify(d.role), d.location, d.stageReached, d.difficulty, d.stagesCount, d.assessmentType,
           d.outcome, d.experience, d.interviewedOn ? `${d.interviewedOn}-01` : null, m.status, m.risk, m.flags, hashOf(d.experience)]);
        for (const qn of d.questions)
          await c.query('INSERT INTO interview_questions(interview_id, question, question_hash) VALUES ($1,$2,$3)', [row.id, qn, sha256(norm(qn))]);
        return row;
      },
    });
  });
  res.status(201).json(out);
}));

// ---------- gist + comments ----------
const CATS = ['SALARY', 'MANAGEMENT', 'OFFICE_POLITICS', 'INTERVIEW', 'PROMOTION', 'WORK_LIFE', 'TOXIC_WORKPLACE', 'CAREER_ADVICE', 'FUNNY', 'REMOTE_WORK', 'OTHER'];
const gistSchema = z.object({ category: z.enum(CATS), body: text(10, 1000), companySlug: z.string().optional() });

contrib.post('/gist', requireAuth, dailyCap('gists', 10), h(async (req, res) => {
  const d = gistSchema.parse(req.body);
  const out = await tx(async (c) => {
    const co = d.companySlug ? await companyBySlug(c, d.companySlug) : null;
    return submit(c, {
      type: 'GIST', user: req.user, texts: [d.body], hash: hashOf(d.body),
      insert: async (m) => (await c.query(
        `INSERT INTO gists(user_id, company_id, category, body, status, risk, flags, body_hash, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $5::moderation_status = 'APPROVED' THEN now() END) RETURNING id`,
        [req.user.id, co?.id ?? null, d.category, d.body, m.status, m.risk, m.flags, hashOf(d.body)])).rows[0],
    });
  });
  res.status(201).json(out);
}));

contrib.post('/gist/:id/comments', requireAuth, dailyCap('gist_comments', 30), h(async (req, res) => {
  const gistId = uuid.parse(req.params.id);
  const d = z.object({ body: text(2, 500) }).parse(req.body);
  const out = await tx(async (c) => {
    const { rows } = await c.query(`SELECT 1 FROM gists WHERE id = $1 AND status = 'APPROVED'`, [gistId]);
    if (!rows.length) throw new HttpError(404, 'Gist not found.');
    return submit(c, {
      type: 'GIST_COMMENT', user: req.user, texts: [d.body], hash: hashOf(d.body),
      insert: async (m) => (await c.query(
        `INSERT INTO gist_comments(gist_id, user_id, body, status, risk, flags, body_hash, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $4::moderation_status = 'APPROVED' THEN now() END) RETURNING id`,
        [gistId, req.user.id, d.body, m.status, m.risk, m.flags, hashOf(d.body)])).rows[0],
    });
  });
  res.status(201).json(out);
}));

// ---------- edit an item that was sent back (NEEDS_EDIT) ----------
contrib.patch('/contributions/:type/:id', requireAuth, h(async (req, res) => {
  const type = z.enum(['REVIEW', 'GIST', 'GIST_COMMENT', 'INTERVIEW', 'REVIEW_RESPONSE']).parse(String(req.params.type).toUpperCase());
  const id = uuid.parse(req.params.id);
  const schema = { REVIEW: z.object({ headline: text(0, 120).optional(), body: text(50, 4000).optional() }),
    GIST: z.object({ body: text(10, 1000) }), GIST_COMMENT: z.object({ body: text(2, 500) }),
    INTERVIEW: z.object({ experience: text(30, 3000) }), REVIEW_RESPONSE: z.object({ body: text(10, 2000) }) }[type];
  const changes = schema.parse(req.body);
  const main = changes.body ?? changes.experience;
  res.json(await tx((c) => resubmit(c, { type, id, user: req.user, changes, hash: main ? hashOf(main) : null })));
}));

// ---------- votes (helpful / like): toggles ----------
async function toggle(req, res, { votes, col, parent, parentWhere = `status = 'APPROVED'`, blockSelf = false }) {
  const id = uuid.parse(req.params.id);
  const { rows: [p] } = await q(`SELECT user_id FROM ${parent} WHERE id = $1 AND ${parentWhere}`, [id]);
  if (!p) throw new HttpError(404, 'Not found.');
  if (blockSelf && p.user_id === req.user.id) throw new HttpError(403, 'You cannot vote on your own contribution.');
  const del = await q(`DELETE FROM ${votes} WHERE ${col} = $1 AND user_id = $2`, [id, req.user.id]);
  if (del.rowCount) return res.json({ active: false });
  await q(`INSERT INTO ${votes}(${col}, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, req.user.id]);
  res.json({ active: true });
}
contrib.post('/reviews/:id/helpful', requireAuth, actionLimit, h((req, res) => toggle(req, res, { votes: 'review_votes', col: 'review_id', parent: 'reviews', blockSelf: true })));
contrib.post('/interviews/:id/helpful', requireAuth, actionLimit, h((req, res) => toggle(req, res, { votes: 'interview_votes', col: 'interview_id', parent: 'interviews', blockSelf: true })));
contrib.post('/gist/:id/like', requireAuth, actionLimit, h((req, res) => toggle(req, res, { votes: 'gist_likes', col: 'gist_id', parent: 'gists' })));

// ---------- saved items ----------
contrib.put('/me/saved/companies/:slug', requireAuth, actionLimit, h(async (req, res) => {
  const { rowCount } = await q(`INSERT INTO saved_companies(user_id, company_id) SELECT $1::uuid, id FROM companies WHERE slug = $2 AND status = 'ACTIVE' ON CONFLICT DO NOTHING`, [req.user.id, req.params.slug]);
  const { rows } = await q('SELECT 1 FROM companies WHERE slug = $1', [req.params.slug]);
  if (!rows.length) throw new HttpError(404, 'Company not found.');
  res.json({ saved: true, created: rowCount > 0 });
}));
contrib.delete('/me/saved/companies/:slug', requireAuth, h(async (req, res) => {
  await q('DELETE FROM saved_companies WHERE user_id = $1 AND company_id = (SELECT id FROM companies WHERE slug = $2)', [req.user.id, req.params.slug]);
  res.json({ saved: false });
}));
contrib.put('/me/saved/gists/:id', requireAuth, actionLimit, h(async (req, res) => {
  const id = uuid.parse(req.params.id);
  await q(`INSERT INTO saved_gists(user_id, gist_id) SELECT $1::uuid, id FROM gists WHERE id = $2 AND status = 'APPROVED' ON CONFLICT DO NOTHING`, [req.user.id, id]);
  res.json({ saved: true });
}));
contrib.delete('/me/saved/gists/:id', requireAuth, h(async (req, res) => {
  await q('DELETE FROM saved_gists WHERE user_id = $1 AND gist_id = $2', [req.user.id, uuid.parse(req.params.id)]);
  res.json({ saved: false });
}));

// ---------- reports ----------
const REASONS = ['HARASSMENT', 'PERSONAL_INFORMATION', 'FALSE_INFORMATION', 'SPAM', 'THREAT', 'HATE_SPEECH', 'DEFAMATION', 'OTHER'];
const reportSchema = z.object({
  entityType: z.enum(Object.keys(ENT)), entityId: uuid, reason: z.enum(REASONS), details: text(0, 1000).optional(),
});
const reportLimit = rateLimit({ windowMs: 3600e3, limit: 20, keyGenerator: (req) => req.user.id, standardHeaders: true, legacyHeaders: false, validate: false });

/**
 * Anti-suppression policy (employers must not be able to remove legitimate negative reviews):
 *  - Reports never delete anything. They only route content to moderators.
 *  - One report is enough to pull content pending review ONLY for PERSONAL_INFORMATION or THREAT, and never when the
 *    reporter is a company representative.
 *  - For every other reason the content stays visible until 3 distinct reporters have flagged it.
 */
contrib.post('/reports', requireAuth, reportLimit, h(async (req, res) => {
  const d = reportSchema.parse(req.body);
  await tx(async (c) => {
    const { table } = ENT[d.entityType];
    const { rows: [target] } = await c.query(`SELECT id FROM ${table} WHERE id = $1 AND status = 'APPROVED'`, [d.entityId]);
    if (!target) throw new HttpError(404, 'Nothing to report.');
    await c.query('INSERT INTO reports(reporter_id, entity_type, entity_id, reason, details) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, d.entityType, d.entityId, d.reason, d.details || null]);
    const { rows: [n] } = await c.query(`SELECT count(DISTINCT r.reporter_id)::int AS n FROM reports r JOIN users u ON u.id = r.reporter_id
        WHERE r.entity_type = $1 AND r.entity_id = $2 AND r.status = 'OPEN' AND u.role <> 'COMPANY_REP'`, [d.entityType, d.entityId]);
    const urgent = ['PERSONAL_INFORMATION', 'THREAT'].includes(d.reason) && req.user.role !== 'COMPANY_REP';
    if (urgent || n.n >= 3) {
      await c.query(`UPDATE ${table} SET status = 'ESCALATED', risk = 'HIGH' WHERE id = $1`, [d.entityId]);
      await c.query(`UPDATE moderation_queue SET status = 'ESCALATED', risk = 'HIGH', decided_by = NULL, decided_at = NULL, flags = array_append(flags, 'REPORTED') WHERE entity_type = $1 AND entity_id = $2`, [d.entityType, d.entityId]);
    }
  });
  res.status(201).json({ ok: true, message: 'Thanks. Our moderators will take a look.' });
}));
