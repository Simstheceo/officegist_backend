import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, sha256, newToken, ipHash } from '../src/lib/crypto.js';

test('password hash verifies and rejects wrong password', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});
test('hashes are salted', async () => {
  assert.notEqual(await hashPassword('same'), await hashPassword('same'));
});
test('tokens are unique and ip hash is keyed and stable', () => {
  assert.notEqual(newToken(), newToken());
  assert.equal(sha256('a').length, 64);
  process.env.IP_HASH_SECRET = 's1'; const a = ipHash('1.2.3.4');
  assert.equal(a, ipHash('1.2.3.4')); assert.equal(a.length, 64);
  process.env.IP_HASH_SECRET = 's2'; assert.notEqual(a, ipHash('1.2.3.4'));
});
