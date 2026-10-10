import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { requireAuth, startSession, endSession, dailyCap } from '../auth.js';
import { h, HttpError, clean, norm } from '../http.js';
import { hashPassword, verifyPassword, sha256, newToken, ipHash } from '../lib/crypto.js';
import { scanText } from '../lib/moderation.js';
import { submit, notify } from '../lib/submit.js';
import { sendMail } from '../lib/mailer.js';
import { config } from '../config.js';

export const account = Router();
const text = (min, max) => z.string().transform(clean).pipe(z.string().min(min).max(max));

// Brute-force protection on credential endpoints: 10 attempts per 15 minutes per IP.
const authLimit = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false });

const creds = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Use at least 8 characters.').max(128),
});

// What a signed-in user sees about themselves. Nobody else ever sees email, phone or IP.
const me = (u) => ({ anonymousName: `Anonymous Employee #${u.anon_number}`, anonNumber: u.anon_number, email: u.email, role: u.role, emailVerified: !!u.email_verified_at });

async function sendEmailVerification(userId, email) {
  const token = newToken();
  await q(`INSERT INTO user_verifications(user_id, kind, token_hash, expires_at) VALUES ($1,'EMAIL',$2, now() + interval '2 days')`, [userId, sha256(token)]);
  await sendMail(email, 'Confirm your OfficeGist email', `Confirm your email: ${config.appOrigin}/verify?token=${token}`);
}

account.post('/auth/register', authLimit, h(async (req, res) => {
  const d = creds.parse(req.body);
  const hash = await hashPassword(d.password);
  let user;
  // anon_number is random; retry once in the very unlikely case two signups pick the same one at once.
  for (let attempt = 0; attempt < 2 && !user; attempt++) {
    try {
      user = (await q('INSERT INTO users(email, password_hash) VALUES ($1,$2) RETURNING id, email, role, anon_number, email_verified_at', [d.email, hash])).rows[0];
    } catch (e) {
      if (!(e.code === '23505' && e.constraint === 'users_anon_number_key' && attempt === 0)) throw e;
    }
  }
  await q('INSERT INTO user_profiles(user_id) VALUES ($1)', [user.id]);
  await startSession(req, res, user.id);
  sendEmailVerification(user.id, user.email).catch((e) => console.error('verification email failed', e));
  res.status(201).json(me(user));
}));

const DUMMY = await hashPassword('timing-equaliser'); // so unknown emails cost the same time as wrong passwords
account.post('/auth/login', authLimit, h(async (req, res) => {
  const d = creds.pick({ email: true }).extend({ password: z.string().min(1).max(128) }).parse(req.body);
  const { rows: [u] } = await q('SELECT id, email, role, anon_number, email_verified_at, status, password_hash FROM users WHERE email = $1', [d.email]);
  const ok = await verifyPassword(d.password, u?.password_hash || DUMMY);
  if (!u || !ok || u.status !== 'ACTIVE') throw new HttpError(401, 'Email or password is incorrect.');
  await startSession(req, res, u.id);
  res.json(me(u));
}));

account.post('/auth/logout', h(async (req, res) => { await endSession(req, res); res.json({ ok: true }); }));

account.get('/me', requireAuth, (req, res) => res.json(me(req.user)));

// Right to erasure: the account and private data go; contributions stay, detached from any identity.
account.delete('/me', requireAuth, h(async (req, res) => {
  const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
  const { rows: [u] } = await q('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(403, 'Password is incorrect.');
  await q('DELETE FROM users WHERE id = $1', [req.user.id]);
  await endSession(req, res);
  res.json({ ok: true });
}));

account.get('/me/contributions', requireAuth, h(async (req, res) => {
  const { rows } = await q(
    `SELECT * FROM (
       SELECT 'REVIEW' AS type, id, status, created_at, left(body, 140) AS snippet FROM reviews WHERE user_id = $1
       UNION ALL SELECT 'GIST', id, status, created_at, left(body, 140) FROM gists WHERE user_id = $1
       UNION ALL SELECT 'SALARY_REPORT', id, status, created_at, job_title FROM salary_reports WHERE user_id = $1
       UNION ALL SELECT 'INTERVIEW', id, status, created_at, left(experience, 140) FROM interviews WHERE user_id = $1
       UNION ALL SELECT 'GIST_COMMENT', id, status, created_at, left(body, 140) FROM gist_comments WHERE user_id = $1
     ) x ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
  res.json(rows);
}));

account.get('/me/saved', requireAuth, h(async (req, res) => {
  const [companies, gists] = await Promise.all([
    q(`SELECT c.slug, c.name, c.avg_rating, c.review_count FROM saved_companies s JOIN companies c ON c.id = s.company_id WHERE s.user_id = $1 ORDER BY s.created_at DESC`, [req.user.id]),
    q(`SELECT g.id, g.anon_number, g.category, g.body, g.published_at FROM saved_gists s JOIN v_public_gists g ON g.id = s.gist_id WHERE s.user_id = $1 ORDER BY s.created_at DESC`, [req.user.id]),
  ]);
  res.json({ companies: companies.rows, gists: gists.rows });
}));

account.get('/me/notifications', requireAuth, h(async (req, res) => {
  const { rows } = await q('SELECT id, type, payload, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json({ unread: rows.filter((n) => !n.read_at).length, items: rows });
}));
account.post('/me/notifications/read', requireAuth, h(async (req, res) => {
  await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));

// ---------- verification ----------
account.get('/me/verifications', requireAuth, h(async (req, res) => {
  const { rows } = await q(
    `SELECT v.kind, v.status, c.slug AS company_slug, v.verified_at FROM user_verifications v LEFT JOIN companies c ON c.id = v.company_id
      WHERE v.user_id = $1 AND v.status <> 'REJECTED' ORDER BY v.created_at DESC`, [req.user.id]);
  res.json({ emailVerified: !!req.user.email_verified_at, items: rows });
}));

account.post('/verifications/email/resend', requireAuth, authLimit, h(async (req, res) => {
  if (!req.user.email_verified_at) await sendEmailVerification(req.user.id, req.user.email);
  res.json({ ok: true });
}));

// Work-email verification marks a user's reviews/salaries at that company as "verified experience".
// We check the email domain against the company website and store only the domain, never the address.
account.post('/verifications/work-email', requireAuth, authLimit, h(async (req, res) => {
  const d = z.object({ companySlug: z.string(), workEmail: z.string().trim().toLowerCase().email() }).parse(req.body);
  const { rows: [c] } = await q(`SELECT id, website FROM companies WHERE slug = $1 AND status = 'ACTIVE'`, [d.companySlug]);
  if (!c) throw new HttpError(404, 'Company not found.');
  const domain = d.workEmail.split('@')[1];
  const site = (c.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  if (!site || !(domain === site || domain.endsWith('.' + site)))
    throw new HttpError(422, 'That email domain does not match this company. You can request manual verification instead.');
  const token = newToken();
  await q(`INSERT INTO user_verifications(user_id, kind, company_id, work_email_domain, token_hash, expires_at) VALUES ($1,'WORK_EMAIL',$2,$3,$4, now() + interval '2 days')`,
    [req.user.id, c.id, domain, sha256(token)]);
  await sendMail(d.workEmail, 'Verify your OfficeGist work email', `Confirm: ${config.appOrigin}/verify?token=${token}`);
  res.json({ ok: true, message: 'Check your work inbox. Your email address is not stored or shown.' });
}));

// POST (not GET) so mail-scanner link prefetching cannot confirm a token by accident.
account.post('/verifications/confirm', authLimit, h(async (req, res) => {
  const { token } = z.object({ token: z.string().min(20).max(100) }).parse(req.body);
  await tx(async (c) => {
    const { rows: [v] } = await c.query(
      `UPDATE user_verifications SET status = 'VERIFIED', verified_at = now(), token_hash = NULL
        WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > now() RETURNING user_id, kind, company_id`, [sha256(token)]);
    if (!v) throw new HttpError(400, 'This link is invalid or has expired.');
    if (v.kind === 'EMAIL') await c.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [v.user_id]);
    if (v.kind === 'WORK_EMAIL') {
      await c.query('UPDATE reviews SET verified_experience = true WHERE user_id = $1 AND company_id = $2', [v.user_id, v.company_id]);
      await c.query('UPDATE salary_reports SET verified_experience = true WHERE user_id = $1 AND company_id = $2', [v.user_id, v.company_id]);
    }
    await notify(c, v.user_id, 'VERIFICATION_VERIFIED', { kind: v.kind });
  });
  res.json({ ok: true });
}));

// ---------- company claiming ----------
account.post('/companies/:slug/claim', requireAuth, h(async (req, res) => {
  const d = z.object({ workEmail: z.string().trim().toLowerCase().email(), roleTitle: text(2, 80), evidenceNote: text(0, 1000).optional() }).parse(req.body);
  const { rows: [c] } = await q(`SELECT id, verified_at FROM companies WHERE slug = $1 AND status = 'ACTIVE'`, [req.params.slug]);
  if (!c) throw new HttpError(404, 'Company not found.');
  // Evidence upload (CAC certificate, staff ID) goes through a signed-URL flow to private storage; evidence_ref holds the key.
  await q(`INSERT INTO company_claims(company_id, user_id, work_email_domain, role_title, evidence_note) VALUES ($1,$2,$3,$4,$5)`,
    [c.id, req.user.id, d.workEmail.split('@')[1], d.roleTitle, d.evidenceNote || null]);
  res.status(201).json({ ok: true, message: 'Claim received. Our team will verify employer evidence before approving it.' });
}));

async function requireMember(userId, companyId) {
  const { rows } = await q('SELECT 1 FROM company_members WHERE user_id = $1 AND company_id = $2', [userId, companyId]);
  if (!rows.length) throw new HttpError(403, 'Only verified representatives of this company can do that.');
}

// Verified employers may edit profile basics. Text is screened; anything flagged is refused rather than published.
account.patch('/companies/:slug', requireAuth, h(async (req, res) => {
  const d = z.object({ description: text(0, 1500).optional(), website: z.string().url().max(200).optional(), logoUrl: z.string().url().max(300).optional() }).parse(req.body);
  const { rows: [c] } = await q(`SELECT id FROM companies WHERE slug = $1`, [req.params.slug]);
  if (!c) throw new HttpError(404, 'Company not found.');
  await requireMember(req.user.id, c.id);
  if (d.description && scanText(d.description).flags.some((f) => ['PHONE_NUMBER', 'EMAIL_ADDRESS', 'SPAM', 'THREAT', 'HATE_SPEECH'].includes(f)))
    throw new HttpError(422, 'The description contains contact details or content we cannot publish.');
  await q('UPDATE companies SET description = COALESCE($1, description), website = COALESCE($2, website), logo_url = COALESCE($3, logo_url) WHERE id = $4',
    [d.description ?? null, d.website ?? null, d.logoUrl ?? null, c.id]);
  res.json({ ok: true });
}));

// Employer response to a review. It is moderated like everything else. Reps cannot edit or delete the review itself.
account.post('/reviews/:id/response', requireAuth, dailyCap('review_responses', 10), h(async (req, res) => {
  const reviewId = z.string().uuid().parse(req.params.id);
  const d = z.object({ body: text(10, 2000) }).parse(req.body);
  const out = await tx(async (c) => {
    const { rows: [r] } = await c.query(`SELECT company_id FROM reviews WHERE id = $1 AND status = 'APPROVED'`, [reviewId]);
    if (!r) throw new HttpError(404, 'Review not found.');
    const { rows: m } = await c.query('SELECT 1 FROM company_members WHERE user_id = $1 AND company_id = $2', [req.user.id, r.company_id]);
    if (!m.length) throw new HttpError(403, 'Only verified representatives of this company can respond.');
    const hash = norm(d.body).length >= 40 ? sha256(norm(d.body)) : null;
    return submit(c, {
      type: 'REVIEW_RESPONSE', user: req.user, texts: [d.body], hash,
      insert: async (mod) => (await c.query(
        `INSERT INTO review_responses(review_id, company_id, user_id, body, status, risk, flags, body_hash, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $5::moderation_status = 'APPROVED' THEN now() END) RETURNING id`,
        [reviewId, r.company_id, req.user.id, d.body, mod.status, mod.risk, mod.flags, hash])).rows[0],
    });
  });
  res.status(201).json(out);
}));

// ---------- product analytics (whitelisted events, no personal data in props) ----------
const EVENTS = ['search', 'view_company', 'view_salary', 'view_interviews', 'start_contribution', 'complete_contribution', 'app_open'];
account.post('/events', rateLimit({ windowMs: 60e3, limit: 60, standardHeaders: true, legacyHeaders: false }), h(async (req, res) => {
  const d = z.object({ event: z.enum(EVENTS), anonId: z.string().max(64).optional(), props: z.record(z.union([z.string().max(100), z.number(), z.boolean()])).default({}) }).parse(req.body);
  await q('INSERT INTO analytics_events(user_id, anon_id, event, props, ip_hash) VALUES ($1,$2,$3,$4,$5)', [req.user?.id ?? null, d.anonId ?? null, d.event, d.props, ipHash(req.ip)]);
  res.status(202).json({ ok: true });
}));
