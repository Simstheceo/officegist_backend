import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { h, HttpError, paging } from '../http.js';
import { setStatus, ENT, notify } from '../lib/submit.js';

export const admin = Router();
const staff = requireRole('MODERATOR', 'ADMIN');
const adminOnly = requireRole('ADMIN');
const uuid = z.string().uuid();

const audit = (c, adminId, action, entityType, entityId, before, after, note) =>
  c.query('INSERT INTO admin_actions(admin_id, action, entity_type, entity_id, before_state, after_state, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [adminId, action, entityType, entityId, before ?? null, after ?? null, note ?? null]);

// Dashboard numbers. "Today" is measured in Lagos time.
admin.get('/admin/stats', staff, h(async (req, res) => {
  const { rows: [s] } = await q(`
    SELECT (SELECT count(*) FROM users)::int AS total_users,
           (SELECT count(*) FROM companies)::int AS total_companies,
           (SELECT count(*) FROM reviews WHERE status = 'APPROVED')::int AS total_reviews,
           (SELECT count(*) FROM gists WHERE status = 'APPROVED')::int AS total_gist_posts,
           (SELECT count(*) FROM salary_reports WHERE status = 'APPROVED')::int AS total_salary_reports,
           (SELECT count(*) FROM interviews WHERE status = 'APPROVED')::int AS total_interview_reports,
           (SELECT count(*) FROM moderation_queue WHERE status IN ('PENDING','ESCALATED'))::int AS pending_moderation,
           (SELECT count(*) FROM moderation_queue WHERE status = 'ESCALATED')::int AS escalated,
           (SELECT count(*) FROM reports WHERE status = 'OPEN')::int AS open_reports,
           (SELECT count(*) FROM users WHERE email_verified_at IS NOT NULL)::int AS verified_users,
           (SELECT count(*) FROM companies WHERE verified_at IS NOT NULL)::int AS verified_companies,
           (SELECT count(*) FROM moderation_queue WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'))::int AS new_submissions_today,
           (SELECT count(DISTINCT user_id) FROM analytics_events WHERE user_id IS NOT NULL AND created_at > now() - interval '7 days')::int AS weekly_active_users`);
  res.json(s);
}));

// Moderation queue: highest risk first, oldest first within a risk level. Includes the text being moderated.
admin.get('/admin/moderation', staff, h(async (req, res) => {
  const { limit, offset, page } = paging(req, 100);
  const status = ['PENDING', 'NEEDS_EDIT', 'ESCALATED', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : null;
  const risk = ['LOW', 'MEDIUM', 'HIGH'].includes(req.query.risk) ? req.query.risk : null;
  const { rows } = await q(
    `SELECT id, entity_type, entity_id, status, risk, flags, author_id, auto, decided_by, decided_at, note, created_at
       FROM moderation_queue
      WHERE ($1::moderation_status IS NULL AND status IN ('PENDING','ESCALATED') OR status = $1)
        AND ($2::risk_level IS NULL OR risk = $2)
      ORDER BY (risk = 'HIGH') DESC, (risk = 'MEDIUM') DESC, created_at ASC LIMIT $3 OFFSET $4`, [status, risk, limit, offset]);
  // Fetch the text for each item, one query per entity type (table names come from the ENT whitelist).
  const byType = {};
  rows.forEach((r) => (byType[r.entity_type] ||= []).push(r.entity_id));
  const texts = {};
  for (const [type, ids] of Object.entries(byType)) {
    const { table, text } = ENT[type];
    const { rows: t } = await q(`SELECT id, concat_ws(E'\\n', ${text.join(', ')}) AS content FROM ${table} WHERE id = ANY($1)`, [ids]);
    t.forEach((x) => (texts[x.id] = x.content));
  }
  res.json({ page, limit, items: rows.map((r) => ({ ...r, content: texts[r.entity_id] ?? null })) });
}));

const decision = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'NEEDS_EDIT', 'ESCALATED']),
  note: z.string().trim().max(500).optional(),
}).refine((d) => d.status === 'APPROVED' || d.status === 'ESCALATED' || !!d.note, { path: ['note'], message: 'Add a short note explaining the decision.' });

admin.post('/admin/moderation/:id/decision', staff, h(async (req, res) => {
  const d = decision.parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows: [item] } = await c.query('SELECT entity_type, entity_id FROM moderation_queue WHERE id = $1', [id]);
    if (!item) throw new HttpError(404, 'Queue item not found.');
    await setStatus(c, { type: item.entity_type, id: item.entity_id, status: d.status, adminId: req.user.id, note: d.note });
  });
  res.json({ ok: true });
}));

admin.get('/admin/reports', staff, h(async (req, res) => {
  const { limit, offset, page } = paging(req, 100);
  const { rows } = await q(
    `SELECT entity_type, entity_id, count(*)::int AS report_count, array_agg(DISTINCT reason) AS reasons, min(created_at) AS first_reported
       FROM reports WHERE status = 'OPEN' GROUP BY entity_type, entity_id
      ORDER BY count(*) DESC, min(created_at) LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json({ page, limit, items: rows });
}));

// Resolve every open report on an item. ACTIONED can also change the content's moderation status in the same step.
admin.post('/admin/reports/resolve', staff, h(async (req, res) => {
  const d = z.object({
    entityType: z.enum(Object.keys(ENT)), entityId: uuid, outcome: z.enum(['ACTIONED', 'DISMISSED']),
    contentStatus: z.enum(['APPROVED', 'REJECTED', 'NEEDS_EDIT']).optional(), note: z.string().trim().max(500).optional(),
  }).parse(req.body);
  await tx(async (c) => {
    if (d.contentStatus) await setStatus(c, { type: d.entityType, id: d.entityId, status: d.contentStatus, adminId: req.user.id, note: d.note });
    const { rowCount } = await c.query(
      `UPDATE reports SET status = $1, handled_by = $2, handled_at = now(), handler_note = $3
        WHERE entity_type = $4 AND entity_id = $5 AND status = 'OPEN'`, [d.outcome, req.user.id, d.note || null, d.entityType, d.entityId]);
    await audit(c, req.user.id, `REPORTS_${d.outcome}`, d.entityType, d.entityId, null, { reports: rowCount, contentStatus: d.contentStatus ?? null }, d.note);
  });
  res.json({ ok: true });
}));

admin.get('/admin/claims', adminOnly, h(async (req, res) => {
  const { rows } = await q(
    `SELECT cl.id, c.slug AS company_slug, c.name AS company_name, cl.user_id, cl.work_email_domain, cl.role_title, cl.evidence_note, cl.evidence_ref, cl.status, cl.created_at
       FROM company_claims cl JOIN companies c ON c.id = cl.company_id
      WHERE cl.status = 'PENDING' ORDER BY cl.created_at LIMIT 100`);
  res.json(rows);
}));

admin.post('/admin/claims/:id/decision', adminOnly, h(async (req, res) => {
  const d = z.object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(500).optional() }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows: [cl] } = await c.query(`UPDATE company_claims SET status = $1, reviewed_by = $2, reviewed_at = now(), decision_note = $3 WHERE id = $4 AND status = 'PENDING' RETURNING company_id, user_id`, [d.status, req.user.id, d.note || null, id]);
    if (!cl) throw new HttpError(404, 'No pending claim with that id.');
    if (d.status === 'APPROVED') {
      await c.query('INSERT INTO company_members(company_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [cl.company_id, cl.user_id]);
      await c.query(`UPDATE users SET role = 'COMPANY_REP' WHERE id = $1 AND role = 'USER'`, [cl.user_id]);
      await c.query('UPDATE companies SET verified_at = COALESCE(verified_at, now()) WHERE id = $1', [cl.company_id]);
    }
    await audit(c, req.user.id, `CLAIM_${d.status}`, 'COMPANY', cl.company_id, { status: 'PENDING' }, { status: d.status, claimant: cl.user_id }, d.note);
    await notify(c, cl.user_id, `CLAIM_${d.status}`, { companyId: cl.company_id });
  });
  res.json({ ok: true });
}));

admin.get('/admin/audit', adminOnly, h(async (req, res) => {
  const { limit, offset, page } = paging(req, 100);
  const { rows } = await q('SELECT id, admin_id, action, entity_type, entity_id, before_state, after_state, note, created_at FROM admin_actions ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
  res.json({ page, limit, items: rows });
}));

// Suspend or reinstate an account. Content stays; the user simply cannot sign in or post.
admin.post('/admin/users/:id/status', adminOnly, h(async (req, res) => {
  const d = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), note: z.string().trim().min(3).max(500) }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows: [u] } = await c.query('UPDATE users SET status = $1 WHERE id = $2 AND role = \'USER\' RETURNING id', [d.status, id]);
    if (!u) throw new HttpError(404, 'User not found, or not a regular user.');
    if (d.status === 'SUSPENDED') await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(c, req.user.id, `USER_${d.status}`, 'USER', id, null, { status: d.status }, d.note);
  });
  res.json({ ok: true });
}));
