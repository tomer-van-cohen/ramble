// node --test test/invite.test.mjs — invite links: no codes to type, credit on first link.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'readable-invite-'));
process.env.DAILY_MINUTES_CAP = '30';
process.env.INVITE_BONUS_MINUTES = '10';
process.env.INVITE_BONUS_MAX = '60';
const registry = await import('../src/registry.js');
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const host = registry.create({ start: false });

test('every account gets a short public invite code', () => {
  assert.match(host.inviteCode, /^[0-9a-f]{8}$/);
  assert.equal(registry.byInvite(host.inviteCode), host);
  assert.equal(registry.byInvite('deadbeef'), null);
  assert.equal(registry.byInvite('../../etc'), null);
});

test('an invite link shows the landing page and remembers who sent it', async () => {
  const r = await fetch(`${base}/i/${host.inviteCode}`);
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /A friend invited you/);
  assert.match(body, new RegExp(`name="ref" value="${host.inviteCode}"`));
  assert.match(r.headers.get('set-cookie'), new RegExp(`^rref=${host.inviteCode}`));
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
});

test('an unknown invite code just lands on the normal page, with no cookie', async () => {
  const r = await fetch(`${base}/i/00000000`, { redirect: 'manual' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  assert.equal(r.headers.get('set-cookie'), null);
});

test('the friend who scans credits the inviter, once, on their first link', () => {
  const friend = registry.create({ referredBy: host.inviteCode, start: false });
  assert.equal(friend.referredBy, host.inviteCode);
  assert.equal(host.dailyCapMinutes(), 30);

  friend.onFirstLink(friend);                       // what onReady does the first time WhatsApp connects
  assert.equal(host.invited, 1);
  assert.equal(host.bonusMinutes, 10);
  assert.equal(host.dailyCapMinutes(), 40);
  assert.equal(friend.dailyCapMinutes(), 30);       // the friend is not credited for arriving

  // The quota actually uses the bigger cap.
  assert.equal(host.reserveUsage(35 * 60), true);
  assert.equal(host.reserveUsage(10 * 60), false);
});

test('a made-up or self-referral credits nobody, and the bonus stops at the ceiling', () => {
  const loner = registry.create({ referredBy: 'ffffffff', start: false });
  assert.equal(loner.referredBy, '');               // unknown codes are not stored
  loner.onFirstLink(loner);
  assert.equal(loner.invited, 0);

  const selfie = registry.create({ start: false });
  selfie.referredBy = selfie.inviteCode;            // pointing at itself
  selfie.onFirstLink(selfie);
  assert.equal(selfie.invited, 0);

  for (let i = 0; i < 9; i++) host.creditInvite();
  assert.equal(host.bonusMinutes, 60);              // capped by INVITE_BONUS_MAX
  assert.equal(host.dailyCapMinutes(), 90);
});
