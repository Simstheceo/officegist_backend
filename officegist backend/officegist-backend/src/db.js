import pg from 'pg';
import { config } from './config.js';

pg.types.setTypeParser(1700, parseFloat); // numeric -> number (ratings, salaries)
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint -> number

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
