import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// User text is stored as plain text. Strip tag-like markup and control characters; the web app must still escape on render.
export const clean = (s) => s
  .replace(/<\/?[a-z][^>]*>/gi, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
export const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const slugify = (s) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const likePattern = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';

export function paging(req, max = 50) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), max);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}
export const cache = (res, seconds = 60) => res.set('Cache-Control', `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`);

const DUPES = {
  users_email_key: 'An account with this email already exists.',
  reviews_one_per_user_company: 'You have already reviewed this company.',
  salary_one_per_user_title_year: 'You have already reported this job title for that year.',
  interviews_hash_user: 'You have already submitted this interview experience.',
  reports_one_per_reporter: 'You have already reported this.',
  company_claims_one_pending: 'You already have a pending claim for this company.',
};

export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError)
    return res.status(422).json({ error: 'Please check the highlighted fields.', issues: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err.code === '23505') return res.status(409).json({ error: DUPES[err.constraint] || 'This looks like a duplicate submission.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}
