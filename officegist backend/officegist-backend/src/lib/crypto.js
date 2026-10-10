import crypto from 'node:crypto';

// scrypt via Node's built-in crypto: no native dependency to install.
// Parameters are stored in the hash string so they can be raised later without breaking old hashes.
const N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 96 * 1024 * 1024;

const scrypt = (pw, salt, n) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, KEYLEN, { N: n, r: R, p: P, maxmem: MAXMEM }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, N);
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, n, salt, key] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), Number(n));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
// Read the secret at call time so tests can set it. Raw IPs are never stored.
export const ipHash = (ip) => crypto.createHmac('sha256', process.env.IP_HASH_SECRET || '').update(String(ip || '')).digest('hex');
