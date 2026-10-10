// node --test test/connectgate.test.mjs — connections are opened a few at a time, newest accounts first (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.CONNECT_CONCURRENCY = '10';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-gate-'));
const { connectSlot, connectQueue, jitter } = await import('../src/connectgate.js');

test('three hundred accounts coming back at once: never more than ten attempts in flight, in the order they asked', async () => {
  let inFlight = 0, peak = 0; const order = [];
  await Promise.all(Array.from({ length: 300 }, async (_, i) => {
    const release = await connectSlot();
    order.push(i); inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2)); // the socket gets its answer
    inFlight--; release(); release(); // twice: open and then close both give it back, once
  }));
  assert.equal(peak, 10); assert.deepEqual(order, Array.from({ length: 300 }, (_, i) => i));
  assert.deepEqual(connectQueue(), { inFlight: 0, waiting: 0 });
});

test('an attempt that never gets an answer gives its slot back on its own', async () => {
  const alive = setInterval(() => {}, 1000); // the slots' own timers are unref'd; on Node 22 the loop would otherwise drain mid-test
  const held = await Promise.all(Array.from({ length: 10 }, () => connectSlot(30)));
  const started = Date.now(); const next = await connectSlot(30); // only free once the ten time out
  assert.ok(Date.now() - started >= 20, 'waited for a slot'); next(); held.forEach((r) => r());
  await new Promise((r) => setTimeout(r, 5)); // the slots are handed back on the next turn
  assert.deepEqual(connectQueue(), { inFlight: 0, waiting: 0 });
  clearInterval(alive);
});

test('sockets that dropped together do not come back together', () => {
  const delays = Array.from({ length: 200 }, () => jitter(8000));
  assert.ok(Math.min(...delays) >= 4800 && Math.max(...delays) <= 11200);
  assert.ok(new Set(delays).size > 150, 'spread out, not one instant');
  assert.equal(jitter(2000, () => 0), 1200); assert.equal(jitter(2000, () => 1), 2800);
});

test('after a restart the most recently linked accounts are started first', async () => {
  const registry = await import('../src/registry.js');
  const started = [];
  const mk = (label, linkedAt) => { const t = registry.create({ label, start: false }); t.linkedAt = linkedAt; t.start = async () => { started.push(label); }; return t; };
  mk('linked last week', Date.now() - 7 * 864e5); mk('linked a minute ago', Date.now() - 60e3); mk('linked an hour ago', Date.now() - 3600e3);
  await registry.startAll();
  assert.deepEqual(started.slice(0, 3), ['linked a minute ago', 'linked an hour ago', 'linked last week']);
});

test('the memory line measures stalls and collections without causing one', async () => {
  const { memoryLine } = await import('../src/health.js');
  const ballast = Array.from({ length: 2_000_000 }, (_, i) => ({ i, s: 'x' + i })); // a few hundred MB of live objects
  const t0 = performance.now(); const line = memoryLine({ total: 300, connected: 250 }); const took = performance.now() - t0;
  assert.ok(took < 50, `took ${took.toFixed(1)}ms`); assert.ok(ballast.length);
  assert.match(line, /longest stall \d+\.\ds · gc: \d+ full, longest \d+ms/);
  assert.ok(!/alive:/.test(line));
});

test('linking downloads the first bundle and the names, not the account\'s old messages', async () => {
  const { wantHistory } = await import('../src/wa.js');
  const { proto } = await import('@whiskeysockets/baileys');
  const T = proto.HistorySync.HistorySyncType;
  assert.equal(wantHistory({ syncType: T.RECENT }), false); assert.equal(wantHistory({ syncType: T.FULL }), false);
  for (const t of [T.INITIAL_BOOTSTRAP, T.PUSH_NAME, T.NON_BLOCKING_DATA, T.INITIAL_STATUS_V3, T.ON_DEMAND]) assert.equal(wantHistory({ syncType: t }), true);
  // Baileys can hand over a notification object rather than a bare type; and never everything off (it warns that breaks id mappings).
  assert.equal(wantHistory(proto.Message.HistorySyncNotification.create({ syncType: T.RECENT })), false);
  assert.equal(wantHistory(proto.Message.HistorySyncNotification.create({ syncType: T.INITIAL_BOOTSTRAP })), true);
});

test('the library\'s id-mapping caches are bounded and keep no timer per entry (scripts/patch-deps.mjs)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['lid-mapping.js', 'libsignal.js']) {
    const src = readFileSync(new URL(`../node_modules/@whiskeysockets/baileys/lib/Signal/${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes('max: 2000') && src.includes('ttlAutopurge: false') && !src.includes('ttlAutopurge: true'), `${f} is patched`);
  }
  // Behaviour, not just text: a bounded cache with a TTL and no autopurge creates no timers.
  const { LRUCache } = await import('lru-cache');
  const before = process.getActiveResourcesInfo().length;
  const c = new LRUCache({ ttl: 3 * 24 * 3600e3, max: 2000, ttlAutopurge: false, updateAgeOnGet: true });
  for (let i = 0; i < 3000; i++) c.set(`pn:${i}`, `lid:${i}`);
  assert.equal(c.size, 2000); assert.equal(process.getActiveResourcesInfo().length, before);
});

test('an account that lost its pairing asks for codes only while someone is on its link page', async () => {
  const { keepPairing } = await import('../src/wa.js');
  assert.equal(keepPairing({ unpaired: false, wanted: false }), true, 'a paired account always reconnects');
  assert.equal(keepPairing({ unpaired: true, wanted: undefined }), true, 'no opinion: keep pairing (a new sign-up)');
  assert.equal(keepPairing({ unpaired: true, wanted: true }), true, 'the link page is open');
  assert.equal(keepPairing({ unpaired: true, wanted: false }), false, 'logged out, no one looking: sleep');
  const { Tenant } = await import('../src/tenant.js');
  const t = new Tenant({ id: 'sleep', createdAt: Date.now() }, join(process.env.DATA_DIR, 'sleep'));
  let woke = 0; t.link = { wake: () => { woke++; return true; } };
  assert.equal(t.wake(), true); assert.equal(woke, 1); assert.ok(Date.now() - t.lastViewedAt < 1000, 'opening the page counts as someone looking');
});

test('an account linked by scanning a QR counts as paired (the library marks only pairing-code links "registered")', async () => {
  const { isPaired, keepPairing } = await import('../src/wa.js');
  const qrLinked = { registered: false, me: { id: '15550100001:3@s.whatsapp.net' } };
  assert.equal(isPaired(qrLinked), true);
  assert.equal(isPaired({ registered: true, me: { id: '15550100002:1@s.whatsapp.net' } }), true);
  assert.equal(isPaired({ registered: false }), false, 'fresh credentials: nothing to resume');
  assert.equal(keepPairing({ unpaired: !isPaired(qrLinked), wanted: false }), true, 'a QR-linked account reconnects even with no one on its page');
});

test('the reason WhatsApp gives for a logout is put into words for the log', async () => {
  const { disconnectWhy } = await import('../src/wa.js');
  assert.equal(disconnectWhy({ data: { tag: 'conflict', attrs: { type: 'device_removed' } } }), 'conflict device_removed');
  assert.equal(disconnectWhy({ data: { reason: '401', location: 'xyz' } }), 'failure 401');
  assert.equal(disconnectWhy({ data: { tag: 'replaced', attrs: {} } }), 'replaced');
  assert.equal(disconnectWhy(new Error('x')), ''); assert.equal(disconnectWhy(undefined), '');
});
