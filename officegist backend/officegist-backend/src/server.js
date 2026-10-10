import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { pool } from './db.js';
import { loadUser, csrfGuard } from './auth.js';
import { errorHandler } from './http.js';
import { pub } from './routes/public.js';
import { account } from './routes/account.js';
import { contrib } from './routes/contribute.js';
import { admin } from './routes/admin.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy); // so req.ip (and rate limits) see the real client behind a proxy

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});
app.use(express.json({ limit: '50kb' }));

app.get('/healthz', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});

// General limit first so abusive traffic is rejected before it costs a database query.
app.use('/api', rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/api', csrfGuard, loadUser);

// Order matters: public reads, then account/auth, then authenticated writes, then staff.
app.use('/api', pub);
app.use('/api', account);
app.use('/api', contrib);
app.use('/api', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(errorHandler);

const server = app.listen(config.port, () => console.log(`OfficeGist API listening on :${config.port}`));
const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
