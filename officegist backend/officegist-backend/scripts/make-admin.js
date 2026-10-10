// Usage: node scripts/make-admin.js you@example.com
// Promotes an existing account to ADMIN. The person must have registered on the site first.
import pg from 'pg';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!email) { console.error('Usage: node scripts/make-admin.js you@example.com'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rowCount } = await client.query(`UPDATE users SET role = 'ADMIN' WHERE email = $1`, [email]);
await client.end();
console.log(rowCount ? `Done: ${email} is now an admin.` : `No account found for ${email}. Register on the site first, then run this again.`);
process.exit(rowCount ? 0 : 1);
