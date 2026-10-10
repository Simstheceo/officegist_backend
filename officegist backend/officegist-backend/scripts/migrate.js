// Applies db/*.sql in order, once each, and records them in schema_migrations.
// Usage: node scripts/migrate.js            (schema only)
//        node scripts/migrate.js --demo     (also loads fictional demo companies)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db');
const withDemo = process.argv.includes('--demo');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  if (file.includes('seed') && !withDemo) continue;
  const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
  if (rowCount) { console.log(`skip   ${file}`); continue; }
  try {
    await client.query(fs.readFileSync(path.join(dir, file), 'utf8')); // each file manages its own BEGIN/COMMIT
    await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    console.log(`apply  ${file}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`FAILED ${file}: ${e.message}`);
    process.exitCode = 1;
    break;
  }
}
await client.end();
