// node --test test/stats.test.mjs — the usage ledger, its summary, the settings distribution and the admin page.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-stats-'));
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TRUST_PROXY = '0';
process.env.STATS_TZ = 'Asia/Jerusalem';
const usage = await import('../src/usage.js');
const { settingsStats } = await import('../src/stats.js');
const registry = await import('../src/registry.js');
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const auth = { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') };

test('the summary: lengths in 10-second steps, hours in the stats time zone, outcomes, speed and per-account spread', () => {
  // 2026-06-01 09:30 UTC is 12:30 in Jerusalem (UTC+3 in summer).
  const at = Date.parse('2026-06-01T09:30:00Z');
  const recs = [
    { at, acct: 'a', sec: 4, outcome: 'delivered', own: true, where: 'chat', total: 3.1 },
    { at, acct: 'a', sec: 12, outcome: 'delivered', own: false, where: 'chat', total: 5.0 },
    { at: at + 864e5, acct: 'a', sec: 25, outcome: 'delivered', own: false, where: 'me', total: 7.2 },
    { at, acct: 'b', sec: 200, outcome: 'delivered', video: true, where: 'chat', total: 20.5 },
    { at, acct: 'c', sec: 9, outcome: 'dropped', reason: 'repeated filler' },
    { at, acct: 'c', sec: 30, outcome: 'failed', reason: 'fetch failed' },
    { at, acct: 'd', sec: 40, outcome: 'cap', reason: 'daily cap' },
  ];
  const s = usage.summarize(recs, { tz: 'Asia/Jerusalem' });
  assert.equal(s.records, 7); assert.equal(s.delivered, 4);
  assert.deepEqual(s.outcomes, { delivered: 4, dropped: 1, failed: 1, cap: 1, skipped: 0 });
  assert.equal(s.deliveredShare, 0.667, 'delivered over processed: the cap and the skips were never attempted');
  assert.equal(s.bins[0].n, 1); assert.equal(s.bins[1].n, 1); assert.equal(s.bins[2].n, 1); assert.equal(s.bins.at(-1).n, 1, 'the last step holds everything over 3 minutes');
  assert.equal(s.hours[12], 4, 'hours are in the stats time zone, not UTC');
  assert.equal(s.length.median, 25, 'the upper median, as the experiment summary counts it'); assert.equal(s.length.under10, 0.25); assert.equal(s.length.over120, 0.25);
  assert.equal(s.accounts.active, 2); assert.equal(s.accounts.returning, 1); assert.equal(s.accounts.capHit, 1);
  assert.equal(s.accounts.byRecs.find((r) => r.label === '2–3').n, 1);
  assert.equal(s.latency.median, 7.2); assert.equal(s.latency.under10, 0.75);
  assert.deepEqual(s.mix.where, { chat: 3, me: 1, control: 0 });
  assert.equal(s.days.length, 2); assert.equal(s.reasons['repeated filler'], 1);
  assert.ok(!JSON.stringify(s).includes('"acct"'), 'account ids never leave the summary');
});

test('records go to a file per day and days beyond the keep window are swept', () => {
  const old = Date.now() - (usage.USAGE_KEEP_DAYS + 2) * 864e5;
  usage.record({ at: old, acct: 'a', sec: 5, outcome: 'delivered' });
  usage.record({ acct: 'a', sec: 5, outcome: 'delivered' });
  usage.record({ acct: 'b', sec: 50, outcome: 'cap', reason: 'daily cap' });
  assert.equal(usage.readRecords({ days: 1 }).length, 2);
  const files = readdirSync(join(process.env.DATA_DIR, 'usage'));
  assert.deepEqual(files, [`rec-${new Date().toISOString().slice(0, 10)}.jsonl`], 'the old day was removed by the sweep that writing a new day triggers');
  assert.equal(usage.readRecords({ days: usage.USAGE_KEEP_DAYS + 5 }).length, 2);
  assert.equal(usage.sweep(), 0);
});

const account = (over = {}) => ({
  linkedAt: Date.now() - 10 * 864e5, ready: true, plan: 'pro', language: 'auto', paused: false, transcribeVideo: false, keepAudio: false,
  enabledGroups: 0, mutedChats: 0, privateChats: 0, invited: 0, referredBy: null, minutesToday: 0, usageHistory: [], commands: [],
  settings: { chats: { on: true, who: 'all', where: 'chat', picked: 0 }, groups: { on: true, who: 'mine', where: 'chat', picked: 0 } },
  settingsUse: { visits: 0, changes: 0 }, totals: { own: 0, others: 0, ownSeconds: 0, othersSeconds: 0 }, ...over,
});

test('the settings distribution: who, where, changed from the defaults, the page, per-chat switches, all-time spread', () => {
  const accounts = [
    account({ totals: { own: 10, others: 30, ownSeconds: 600, othersSeconds: 1800 }, usageHistory: [{ day: new Date(Date.now() - 864e5).toISOString().slice(0, 10), minutes: 4 }] }),
    account({ settings: { chats: { on: true, who: 'mine', where: 'me', picked: 0 }, groups: { on: true, who: 'mine', where: 'me', picked: 0 } }, settingsUse: { visits: 3, changes: 1 }, language: 'he', privateChats: 2, commands: [{ cmd: 'private' }, { cmd: 'settings' }] }),
    account({ settings: { chats: { on: true, who: 'all', where: 'chat', picked: 2 }, groups: { on: false, who: 'mine', where: 'chat', picked: 0 } }, settingsUse: { visits: 1, changes: 2 }, enabledGroups: 1, referredBy: 'x', minutesToday: 3 }),
    { linkedAt: null, settings: null }, // never linked: left out of everything
  ];
  const s = settingsStats(accounts);
  assert.equal(s.linked, 3); assert.equal(s.accounts, 4);
  assert.deepEqual(s.chats.who, { mine: 1, others: 0, all: 2 });
  assert.deepEqual(s.groups.who, { mine: 2, others: 0, all: 0 }); assert.equal(s.groups.off, 1);
  assert.deepEqual(s.where, { chat: 2, me: 1, mixed: 0 });
  assert.equal(s.defaults, 1); assert.equal(s.changedFromDefault, 2);
  assert.deepEqual(s.page, { visited: 2, changed: 2, visits: 4, changes: 3 });
  assert.deepEqual(s.perChat, { includedGroups: 1, excludedChats: 0, privateChats: 1, any: 2 });
  assert.deepEqual(s.language.pinned, [{ code: 'he', name: 'Hebrew', n: 1 }]); assert.equal(s.language.auto, 2);
  assert.equal(s.ever.recordings, 40); assert.equal(s.ever.minutes, 40); assert.equal(s.ever.usedAtAll, 1);
  assert.equal(s.ever.byMinutes.find((r) => r.label === '30–60').n, 1);
  assert.equal(s.week.active, 2);
  assert.equal(s.combos[0].n, 1); assert.ok(s.combos.every((c) => /^chats .* · groups .*$/.test(c.label)));
  assert.deepEqual(s.commands, [{ cmd: 'private', n: 1 }, { cmd: 'settings', n: 1 }]);
  assert.equal(s.invited.byInvite, 1);
});

test('the usage page is behind the admin password and draws without inline styles; the JSON carries both halves', async () => {
  const t = registry.create({ start: false });
  t.linkedAt = Date.now() - 864e5; t.ready = true;
  usage.record({ acct: t.id, sec: 14, outcome: 'delivered', own: true, where: 'chat', total: 4.2 });
  assert.equal((await fetch(`${base}/admin/stats`)).status, 401);
  const r = await fetch(`${base}/admin/stats?days=7`, { headers: auth });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /<h1 class="small">Usage<\/h1>/);
  assert.match(html, /Length, in 10-second steps/);
  assert.match(html, /By hour of day/);
  assert.ok(!/ style="/.test(html), 'no inline style attributes: the CSP would drop them');
  assert.match(html, /<html lang="en" dir="ltr">/);
  const j = await (await fetch(`${base}/admin/stats.json?days=30`, { headers: auth })).json();
  assert.equal(j.days, 30); assert.equal(j.s.linked, 1);
  assert.equal(j.u.delivered, 2, 'this recording and the one the ledger test wrote today'); assert.equal(j.u.bins[1].n, 1); assert.equal(j.u.outcomes.cap, 1);
  const bad = await fetch(`${base}/admin/stats.json?days=999`, { headers: auth });
  assert.equal((await bad.json()).days, 7, 'an unknown period is the default');
});
