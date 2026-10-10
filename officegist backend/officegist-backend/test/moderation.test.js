import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, decide } from '../src/lib/moderation.js';

const flags = (t) => scanText(t).flags;

test('flags phone numbers in common Nigerian formats', () => {
  for (const t of ['call 0803 123 4567', 'reach me +2348031234567', 'on 08031234567 please', '+234 803 123 4567'])
    assert.ok(flags(t).includes('PHONE_NUMBER'), t);
});
test('does not mistake salary figures for phone numbers', () => {
  assert.deepEqual(flags('Pay range was 180000-350000 monthly, bonus 500000 yearly'), []);
  assert.deepEqual(flags('Earned ₦250,000 a month plus 50000 transport'), []);
});
test('flags emails, including obfuscated', () => {
  assert.ok(flags('mail ada@gmail.com').includes('EMAIL_ADDRESS'));
  assert.ok(flags('ada at gmail dot com').includes('EMAIL_ADDRESS'));
});
test('flags street addresses', () => {
  assert.ok(flags('he lives at No. 12 Adeola Odeku Street').includes('HOME_ADDRESS'));
});
test('flags threats, spam, links, profanity', () => {
  assert.ok(flags('I will kill him').includes('THREAT'));
  assert.ok(flags('buy followers cheap, whatsapp me').includes('SPAM'));
  assert.ok(flags('see https://x.example/y').includes('LINK'));
  assert.ok(flags('what the fuck').includes('PROFANITY'));
});
test('named individuals', () => {
  assert.ok(flags('Mr Bello shouted at us').includes('NAMED_INDIVIDUAL'));
  assert.ok(flags('my manager Sarah Okon was unfair').includes('NAMED_INDIVIDUAL'));
  assert.ok(!flags('my manager is supportive and the CEO was visible').includes('NAMED_INDIVIDUAL'));
});
test('clean review text has no flags', () => {
  assert.deepEqual(flags('Good people and decent training, but approvals are slow and overtime is often unpaid.'), []);
});
test('decide: named person + criminal allegation + phone -> ESCALATED HIGH', () => {
  const f = flags('My manager Mr. Bello is a thief, call 0803 123 4567.');
  const d = decide(f);
  assert.equal(d.status, 'ESCALATED'); assert.equal(d.risk, 'HIGH');
  assert.ok(d.issues.includes('Remove phone numbers.'));
});
test('decide: phone only -> NEEDS_EDIT with guidance', () => {
  const d = decide(['PHONE_NUMBER']);
  assert.equal(d.status, 'NEEDS_EDIT'); assert.deepEqual(d.issues, ['Remove phone numbers.']);
});
test('decide: threat -> ESCALATED; spam -> PENDING MEDIUM', () => {
  assert.equal(decide(['THREAT']).status, 'ESCALATED');
  const d = decide(['SPAM']); assert.equal(d.status, 'PENDING'); assert.equal(d.risk, 'MEDIUM');
});
test('decide: LOW is PENDING unless auto-approve is on and account is old enough', () => {
  assert.equal(decide([]).status, 'PENDING');
  assert.equal(decide([], { autoApproveLow: true, accountAgeHours: 2 }).status, 'PENDING');
  const d = decide([], { autoApproveLow: true, accountAgeHours: 48 });
  assert.equal(d.status, 'APPROVED'); assert.equal(d.auto, true);
});
test('HATE_TERMS env list is honoured', async () => {
  process.env.HATE_TERMS = 'examplehateword';
  assert.ok(flags('this is an examplehateword here').includes('HATE_SPEECH'));
  delete process.env.HATE_TERMS;
});
