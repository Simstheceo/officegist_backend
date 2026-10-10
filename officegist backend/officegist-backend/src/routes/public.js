import { Router } from 'express';
import { q } from '../db.js';
import { config } from '../config.js';
import { h, HttpError, paging, cache, likePattern } from '../http.js';

export const pub = Router();
const K = () => config.minSalaryReports;

// Public reads use only v_public_* views (no user ids, emails or IPs) and aggregates.
const COMPANY_CARD = `
  c.slug, c.name, i.name AS industry, c.logo_url, c.is_demo, (c.verified_at IS NOT NULL) AS verified,
  c.avg_rating, c.review_count,
  (SELECT l.city FROM company_locations l WHERE l.company_id = c.id ORDER BY l.is_hq DESC, l.city LIMIT 1) AS city`;

// Median and typical range (25th to 75th percentile), rounded to the nearest 1,000 naira.
const SAL_STATS = `
  count(*)::int AS reports,
  round((percentile_cont(0.5)  WITHIN GROUP (ORDER BY base_monthly::float8))::numeric, -3) AS median,
  round((percentile_cont(0.25) WITHIN GROUP (ORDER BY base_monthly::float8))::numeric, -3) AS low,
  round((percentile_cont(0.75) WITHIN GROUP (ORDER BY base_monthly::float8))::numeric, -3) AS high,
  max(published_at) AS last_updated`;

pub.get('/industries', h(async (req, res) => {
  cache(res, 3600);
  res.json((await q('SELECT slug, name FROM industries ORDER BY name')).rows);
}));

// Search by company, industry, location or job title (with autocomplete-friendly short results).
pub.get('/search', h(async (req, res) => {
  const term = String(req.query.q || '').trim().slice(0, 80);
  if (term.length < 2) return res.json({ companies: [], jobTitles: [] });
  cache(res, 30);
  const [companies, titles] = await Promise.all([
    q(`SELECT ${COMPANY_CARD}
         FROM companies c LEFT JOIN industries i ON i.id = c.industry_id
        WHERE c.status = 'ACTIVE'
          AND (c.name % $1 OR c.name ILIKE $2 OR i.name ILIKE $2
               OR EXISTS (SELECT 1 FROM company_locations l WHERE l.company_id = c.id AND (l.city ILIKE $2 OR l.state ILIKE $2)))
        ORDER BY greatest(similarity(c.name, $1), CASE WHEN c.name ILIKE $2 THEN 0.5 ELSE 0 END) DESC, c.review_count DESC
        LIMIT 8`, [term, likePattern(term)]),
    q(`SELECT job_title_slug AS slug, min(job_title) AS title
         FROM salary_reports WHERE status = 'APPROVED' AND job_title ILIKE $1
        GROUP BY 1 ORDER BY count(*) DESC LIMIT 5`, [likePattern(term)]),
  ]);
  res.json({ companies: companies.rows, jobTitles: titles.rows });
}));

pub.get('/companies', h(async (req, res) => {
  cache(res, 60);
  const { limit, offset, page } = paging(req);
  const sort = { rating: 'c.avg_rating DESC NULLS LAST', reviews: 'c.review_count DESC', name: 'c.name ASC' }[req.query.sort] || 'c.review_count DESC';
  const { rows } = await q(
    `SELECT ${COMPANY_CARD}, count(*) OVER ()::int AS total
       FROM companies c LEFT JOIN industries i ON i.id = c.industry_id
      WHERE c.status = 'ACTIVE'
        AND ($1::text IS NULL OR i.slug = $1)
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM company_locations l WHERE l.company_id = c.id AND (l.city ILIKE $2 OR l.state ILIKE $2)))
      ORDER BY ${sort}, c.name LIMIT $3 OFFSET $4`,
    [req.query.industry || null, req.query.location ? likePattern(String(req.query.location)) : null, limit, offset]);
  res.json({ page, limit, total: rows[0]?.total ?? 0, items: rows.map(({ total, ...r }) => r) });
}));

pub.get('/companies/trending', h(async (req, res) => {
  cache(res, 300);
  const { rows } = await q(
    `SELECT ${COMPANY_CARD}
       FROM companies c LEFT JOIN industries i ON i.id = c.industry_id
      WHERE c.status = 'ACTIVE'
      ORDER BY (SELECT count(*) FROM reviews r WHERE r.company_id = c.id AND r.status = 'APPROVED' AND r.published_at > now() - interval '30 days') DESC,
               c.review_count DESC LIMIT 6`);
  res.json(rows);
}));

pub.get('/companies/:slug', h(async (req, res) => {
  cache(res, 60);
  const { rows: [c] } = await q(
    `SELECT c.id, c.slug, c.name, i.name AS industry, c.description, c.website, c.logo_url, c.employee_band, c.is_demo,
            (c.verified_at IS NOT NULL) AS verified, c.review_count, c.avg_rating, c.recommend_pct,
            (SELECT jsonb_agg(jsonb_build_object('city', l.city, 'state', l.state, 'hq', l.is_hq)) FROM company_locations l WHERE l.company_id = c.id) AS locations
       FROM companies c LEFT JOIN industries i ON i.id = c.industry_id
      WHERE c.slug = $1 AND c.status = 'ACTIVE'`, [req.params.slug]);
  if (!c) throw new HttpError(404, 'Company not found.');
  const { rows: dims } = await q(
    `SELECT rr.dimension, round(avg(rr.score), 1) AS avg
       FROM review_ratings rr JOIN reviews r ON r.id = rr.review_id
      WHERE r.company_id = $1 AND r.status = 'APPROVED' GROUP BY 1`, [c.id]);
  const { id, ...out } = c;
  const label = c.review_count ? `${c.avg_rating}/5 from ${c.review_count} employee reviews` : 'Employee reviews, salaries and interviews';
  res.json({
    ...out,
    ratings: Object.fromEntries(dims.map((d) => [d.dimension, d.avg])),
    // Ready-made SEO metadata for the web app's <head>. aggregateRating is only emitted when real reviews exist.
    seo: {
      title: `${c.name} reviews, salaries and interviews | OfficeGist`,
      description: `${c.name}: ${label}. Anonymous, employee-powered workplace intelligence.`,
      canonical: `${config.appOrigin}/companies/${c.slug}`,
      jsonLd: {
        '@context': 'https://schema.org', '@type': 'Organization', name: c.name, url: c.website || undefined,
        ...(c.review_count >= 3 ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: c.avg_rating, reviewCount: c.review_count, bestRating: 5, worstRating: 1 } } : {}),
      },
    },
  });
}));

pub.get('/companies/:slug/reviews', h(async (req, res) => {
  const { limit, offset, page } = paging(req);
  const order = { recent: 'published_at DESC', helpful: 'helpful_count DESC, published_at DESC', high: 'overall_rating DESC, published_at DESC', low: 'overall_rating ASC, published_at DESC' }[req.query.sort] || 'published_at DESC';
  const employment = ['CURRENT', 'FORMER'].includes(req.query.employment) ? req.query.employment : null;
  const { rows } = await q(
    `SELECT v.* FROM v_public_reviews v JOIN companies c ON c.id = v.company_id
      WHERE c.slug = $1 AND c.status = 'ACTIVE' AND ($2::employment_status IS NULL OR v.employment = $2)
      ORDER BY ${order} LIMIT $3 OFFSET $4`, [req.params.slug, employment, limit, offset]);
  res.set('Cache-Control', 'no-store');
  res.json({ page, limit, items: rows.map(({ company_id, ...r }) => r) });
}));

pub.get('/companies/:slug/interviews', h(async (req, res) => {
  cache(res, 60);
  const { limit, offset, page } = paging(req);
  const { rows: [c] } = await q(`SELECT id FROM companies WHERE slug = $1 AND status = 'ACTIVE'`, [req.params.slug]);
  if (!c) throw new HttpError(404, 'Company not found.');
  const [items, common] = await Promise.all([
    q('SELECT * FROM v_public_interviews WHERE company_id = $1 ORDER BY published_at DESC LIMIT $2 OFFSET $3', [c.id, limit, offset]),
    q(`SELECT min(q.question) AS question, count(*)::int AS times
         FROM interview_questions q JOIN interviews i ON i.id = q.interview_id
        WHERE i.company_id = $1 AND i.status = 'APPROVED'
        GROUP BY q.question_hash ORDER BY times DESC, min(q.question) LIMIT 10`, [c.id]),
  ]);
  res.json({ page, limit, items: items.rows.map(({ company_id, ...r }) => r), commonQuestions: common.rows });
}));

// Salary figures are shown only when at least MIN_SALARY_REPORTS approved reports exist (k-anonymity).
pub.get('/companies/:slug/salaries', h(async (req, res) => {
  cache(res, 300);
  const { rows } = await q(
    `SELECT s.job_title_slug AS slug, min(s.job_title) AS title, ${SAL_STATS}
       FROM salary_reports s JOIN companies c ON c.id = s.company_id
      WHERE c.slug = $1 AND s.status = 'APPROVED'
      GROUP BY s.job_title_slug HAVING count(*) >= $2 ORDER BY count(*) DESC LIMIT 20`, [req.params.slug, K()]);
  res.json({ minimumReports: K(), items: rows });
}));

pub.get('/salaries', h(async (req, res) => {
  cache(res, 300);
  const { rows } = await q(
    `SELECT job_title_slug AS slug, min(job_title) AS title, ${SAL_STATS}
       FROM salary_reports WHERE status = 'APPROVED'
      GROUP BY 1 HAVING count(*) >= $1 ORDER BY count(*) DESC LIMIT 30`, [K()]);
  res.json({ currency: 'NGN', period: 'MONTHLY', minimumReports: K(), items: rows });
}));

pub.get('/salaries/:titleSlug', h(async (req, res) => {
  cache(res, 300);
  const [all, byCompany] = await Promise.all([
    q(`SELECT min(job_title) AS title, ${SAL_STATS} FROM salary_reports WHERE status = 'APPROVED' AND job_title_slug = $1`, [req.params.titleSlug]),
    q(`SELECT c.slug, c.name, ${SAL_STATS}
         FROM salary_reports s JOIN companies c ON c.id = s.company_id
        WHERE s.status = 'APPROVED' AND s.job_title_slug = $1
        GROUP BY c.id HAVING count(*) >= $2 ORDER BY count(*) DESC LIMIT 10`, [req.params.titleSlug, K()]),
  ]);
  const a = all.rows[0];
  if (!a.reports) throw new HttpError(404, 'No salary data for this job title yet.');
  const enough = a.reports >= K();
  res.json({
    slug: req.params.titleSlug, title: a.title, currency: 'NGN', period: 'MONTHLY', reports: a.reports, minimumReports: K(),
    // Below the threshold we say how many reports exist but reveal no figures.
    ...(enough ? { median: a.median, low: a.low, high: a.high, lastUpdated: a.last_updated, byCompany: byCompany.rows } : { insufficientData: true }),
  });
}));

pub.get('/interviews', h(async (req, res) => {
  cache(res, 60);
  const { limit, offset, page } = paging(req);
  const { rows } = await q(
    `SELECT v.*, c.slug AS company_slug, c.name AS company_name
       FROM v_public_interviews v JOIN companies c ON c.id = v.company_id
      WHERE ($1::text IS NULL OR v.role_slug = $1)
      ORDER BY v.published_at DESC LIMIT $2 OFFSET $3`, [req.query.role || null, limit, offset]);
  res.json({ page, limit, items: rows.map(({ company_id, ...r }) => r) });
}));

// Gist feed uses keyset pagination: pass the previous response's nextCursor.
pub.get('/gist', h(async (req, res) => {
  const category = String(req.query.category || '').toUpperCase().replace(/ /g, '_');
  const valid = ['SALARY', 'MANAGEMENT', 'OFFICE_POLITICS', 'INTERVIEW', 'PROMOTION', 'WORK_LIFE', 'TOXIC_WORKPLACE', 'CAREER_ADVICE', 'FUNNY', 'REMOTE_WORK', 'OTHER'];
  let at = null, id = null;
  if (req.query.cursor) {
    const [t, i] = Buffer.from(String(req.query.cursor), 'base64url').toString().split('|');
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:?\d\d)?$/.test(t || '') || !/^[0-9a-f-]{36}$/.test(i || '')) throw new HttpError(400, 'Bad cursor.');
    at = t; id = i;
  }
  const { rows } = await q(
    `SELECT *, published_at::text AS cursor_ts FROM v_public_gists
      WHERE ($1::gist_category IS NULL OR category = $1)
        AND ($2::timestamptz IS NULL OR (published_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY published_at DESC, id DESC LIMIT 21`, [valid.includes(category) ? category : null, at, id]);
  const page20 = rows.slice(0, 20);
  const items = page20.map(({ cursor_ts, ...g }) => g);
  // Per-user flags (liked/saved) make this response private; anonymous responses stay cacheable.
  if (req.user && items.length) {
    const ids = items.map((g) => g.id);
    const [likes, saves] = await Promise.all([
      q('SELECT gist_id FROM gist_likes WHERE user_id = $1 AND gist_id = ANY($2)', [req.user.id, ids]),
      q('SELECT gist_id FROM saved_gists WHERE user_id = $1 AND gist_id = ANY($2)', [req.user.id, ids]),
    ]);
    const L = new Set(likes.rows.map((r) => r.gist_id)), S = new Set(saves.rows.map((r) => r.gist_id));
    items.forEach((g) => { g.likedByMe = L.has(g.id); g.savedByMe = S.has(g.id); });
    res.set('Cache-Control', 'private, no-store');
  } else cache(res, 30);
  const last = page20[page20.length - 1];
  // The cursor carries the exact database timestamp (microseconds), so no row is skipped or repeated.
  res.json({ items, nextCursor: rows.length > 20 && last ? Buffer.from(`${last.cursor_ts}|${last.id}`).toString('base64url') : null });
}));

pub.get('/gist/:id/comments', h(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(400, 'Bad id.');
  const { rows } = await q('SELECT id, anon_number, body, published_at FROM v_public_gist_comments WHERE gist_id = $1 ORDER BY published_at LIMIT 100', [req.params.id]);
  res.json(rows);
}));

// Sitemap for crawlers: company pages, salary pages (only those with enough data), interview role pages, industries.
pub.get('/sitemap.xml', h(async (req, res) => {
  const [co, sal, roles, ind] = await Promise.all([
    q(`SELECT slug, updated_at FROM companies WHERE status = 'ACTIVE'`),
    q(`SELECT job_title_slug AS slug FROM salary_reports WHERE status = 'APPROVED' GROUP BY 1 HAVING count(*) >= $1`, [K()]),
    q(`SELECT role_slug AS slug FROM interviews WHERE status = 'APPROVED' GROUP BY 1`),
    q('SELECT slug FROM industries'),
  ]);
  const u = (path, d) => `<url><loc>${config.appOrigin}${path}</loc>${d ? `<lastmod>${new Date(d).toISOString().slice(0, 10)}</lastmod>` : ''}</url>`;
  const body = [u('/'), u('/best-companies/nigeria'),
    ...co.rows.flatMap((r) => [u(`/companies/${r.slug}`, r.updated_at), u(`/interviews/${r.slug}`)]),
    ...sal.rows.map((r) => u(`/salaries/${r.slug}`)), ...roles.rows.map((r) => u(`/interviews/${r.slug}`)),
    ...ind.rows.map((r) => u(`/industries/${r.slug}`))].join('');
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600')
    .send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
}));
