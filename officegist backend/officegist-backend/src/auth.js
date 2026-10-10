import { q } from './db.js';
import { config } from './config.js';
import { sha256, newToken, ipHash } from './lib/crypto.js';
import { HttpError, h } from './http.js';

const COOKIE = 'og_session';
const SESSION_DAYS = 30;

const readCookie = (req, name) => {
  const hit = (req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
};

export async function startSession(req, res, userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  await q('INSERT INTO sessions(user_id, token_hash, ip_hash, user_agent, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [userId, sha256(token), ipHash(req.ip), (req.get('user-agent') || '').slice(0, 200), expires]);
  res.cookie(COOKIE, token, { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', expires, path: '/' });
}

export async function endSession(req, res) {
  const t = readCookie(req, COOKIE);
  if (t) await q('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(t)]);
  res.clearCookie(COOKIE, { path: '/' });
}

// Attaches req.user (or null). Never throws for anonymous visitors.
export const loadUser = h(async (req, res, next) => {
  req.user = null;
  const t = readCookie(req, COOKIE);
  if (t) {
    const { rows: [u] } = await q(
      `SELECT u.id, u.email, u.role, u.anon_number, u.status, u.email_verified_at, u.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sha256(t)]);
    if (u && u.status === 'ACTIVE') req.user = u;
  }
  next();
});

export const requireAuth = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in.')));
export const requireRole = (...roles) => (req, res, next) =>
  !req.user ? next(new HttpError(401, 'Please sign in.')) : roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Not allowed.'));

// CSRF defence for cookie auth: SameSite=Lax cookie + origin check + JSON-only writes (forms cannot send JSON cross-site).
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== config.appOrigin) return next(new HttpError(403, 'Bad origin.'));
  if (!(req.get('content-type') || '').startsWith('application/json')) return next(new HttpError(415, 'Send JSON with Content-Type: application/json.'));
  next();
}

// Per-user rolling 24h cap on how many rows a user may create in a table (table name is a code literal, never user input).
export const dailyCap = (table, max) => h(async (req, res, next) => {
  const { rows: [r] } = await q(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [req.user.id]);
  if (r.n >= max) throw new HttpError(429, `Daily limit reached (${max} per day). Please try again tomorrow.`);
  next();
});
