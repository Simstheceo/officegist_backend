import { scanText, decide } from './moderation.js';
import { config } from '../config.js';
import { HttpError } from '../http.js';

// Whitelist of moderated entities. Table and column names come only from here, never from user input.
export const ENT = {
  REVIEW:          { table: 'reviews',          text: ['headline', 'body'], editable: ['headline', 'body'] },
  GIST:            { table: 'gists',            text: ['body'],             editable: ['body'] },
  GIST_COMMENT:    { table: 'gist_comments',    text: ['body'],             editable: ['body'] },
  SALARY_REPORT:   { table: 'salary_reports',   text: ['job_title', 'department'], editable: [] },
  INTERVIEW:       { table: 'interviews',       text: ['experience'],       editable: ['experience'] },
  REVIEW_RESPONSE: { table: 'review_responses', text: ['body'],             editable: ['body'] },
};

export async function notify(c, userId, type, payload = {}) {
  if (userId) await c.query('INSERT INTO notifications(user_id, type, payload) VALUES ($1,$2,$3)', [userId, type, payload]);
}

// Signals that need the database: copy-pasted text, burst activity on one company, shared network between reviewers.
async function dbSignals(c, { type, hash, userId, companyId }) {
  const flags = [];
  if (hash) {
    const { rows } = await c.query(`SELECT 1 FROM ${ENT[type].table} WHERE body_hash = $1 LIMIT 1`, [hash]);
    if (rows.length) flags.push('DUPLICATE_CONTENT');
  }
  if (type === 'REVIEW' && companyId) {
    const { rows: [b] } = await c.query(
      `SELECT count(*)::int AS n FROM reviews r JOIN users u ON u.id = r.user_id
        WHERE r.company_id = $1 AND r.created_at > now() - interval '24 hours' AND u.created_at > now() - interval '7 days'`, [companyId]);
    // Shared IP is a weak signal on Nigerian mobile networks (carrier NAT), so it only routes to a human; it never rejects.
    const { rows: [s] } = await c.query(
      `SELECT count(DISTINCT r.user_id)::int AS n FROM reviews r JOIN sessions s ON s.user_id = r.user_id
        WHERE r.company_id = $1 AND r.user_id <> $2 AND r.created_at > now() - interval '7 days'
          AND s.ip_hash IN (SELECT ip_hash FROM sessions WHERE user_id = $2 AND ip_hash IS NOT NULL)`, [companyId, userId]);
    if (b.n >= 3 || s.n >= 1) flags.push('COORDINATED_ACTIVITY');
  }
  return flags;
}

const accountAgeHours = (user) => (Date.now() - new Date(user.created_at).getTime()) / 36e5;

/**
 * Run a new contribution through the pipeline inside the caller's transaction.
 * insert(decision) must INSERT the row using decision.status / risk / flags and return { id }.
 */
export async function submit(c, { type, user, texts, hash, companyId, extraFlags = [], insert }) {
  const scan = scanText(texts.filter(Boolean).join('\n'));
  const sig = await dbSignals(c, { type, hash, userId: user.id, companyId });
  const flags = [...new Set([...scan.flags, ...sig, ...extraFlags])];
  const d = decide(flags, { accountAgeHours: accountAgeHours(user), autoApproveLow: config.autoApproveLow });
  const row = await insert(d);
  await c.query(
    `INSERT INTO moderation_queue(entity_type, entity_id, status, risk, flags, author_id, auto, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::boolean THEN now() END)`,
    [type, row.id, d.status, d.risk, flags, user.id, d.auto]);
  // Public response: guidance for edits, but never the detail of why something was escalated.
  return { id: row.id, status: d.status, message: d.message, issues: d.issues };
}

/** Author edits a NEEDS_EDIT item; the full pipeline runs again. */
export async function resubmit(c, { type, id, user, changes, hash }) {
  const { table, editable } = ENT[type];
  const keys = Object.keys(changes).filter((k) => editable.includes(k));
  if (!keys.length) throw new HttpError(400, 'Nothing editable.');
  const { rows: [cur] } = await c.query(`SELECT id, status FROM ${table} WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, user.id]);
  if (!cur) throw new HttpError(404, 'Not found.');
  if (cur.status !== 'NEEDS_EDIT') throw new HttpError(409, 'Only items marked "needs edit" can be changed.');

  const scan = scanText(keys.map((k) => changes[k]).join('\n'));
  const d = decide(scan.flags, { accountAgeHours: accountAgeHours(user), autoApproveLow: config.autoApproveLow });
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
  await c.query(
    `UPDATE ${table} SET ${sets}, status = $1::moderation_status, risk = $2::risk_level, flags = $${keys.length + 3},
            body_hash = COALESCE($${keys.length + 4}, body_hash),
            published_at = CASE WHEN $1::moderation_status = 'APPROVED' THEN now() ELSE published_at END
      WHERE id = $${keys.length + 5}`,
    [d.status, d.risk, ...keys.map((k) => changes[k]), d.flags, hash || null, id]);
  await c.query(
    `UPDATE moderation_queue SET status = $1, risk = $2, flags = $3, auto = $4, decided_by = NULL, decided_at = NULL, note = NULL
      WHERE entity_type = $5 AND entity_id = $6`, [d.status, d.risk, d.flags, d.auto, type, id]);
  return { id, status: d.status, message: d.message, issues: d.issues };
}

/** Moderator/admin decision. Updates content, queue and the audit log together, and tells the author. */
export async function setStatus(c, { type, id, status, adminId, note }) {
  const { table } = ENT[type];
  const { rows: [before] } = await c.query(`SELECT id, user_id, status FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!before) throw new HttpError(404, 'Not found.');
  await c.query(
    `UPDATE ${table} SET status = $1::moderation_status,
            published_at = CASE WHEN $1::moderation_status = 'APPROVED' THEN COALESCE(published_at, now()) ELSE published_at END
      WHERE id = $2`, [status, id]);
  await c.query(
    `UPDATE moderation_queue SET status = $1, decided_by = $2, decided_at = now(), note = $3, auto = false
      WHERE entity_type = $4 AND entity_id = $5`, [status, adminId, note || null, type, id]);
  await c.query(
    `INSERT INTO admin_actions(admin_id, action, entity_type, entity_id, before_state, after_state, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [adminId, `MODERATION_${status}`, type, id, { status: before.status }, { status }, note || null]);
  // Only NEEDS_EDIT notes are written for the author. Other notes stay internal.
  await notify(c, before.user_id, `CONTRIBUTION_${status}`, { entityType: type, entityId: id, ...(status === 'NEEDS_EDIT' && note ? { note } : {}) });
  return before;
}
