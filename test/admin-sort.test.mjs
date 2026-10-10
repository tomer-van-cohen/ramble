// node --test test/admin-sort.test.mjs — the admin list sorted by minutes: today, 7 days, all time.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-admin-sort-'));
process.env.MAX_TENANTS = '500';
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.TRUST_PROXY = '0';
const registry = await import('../src/registry.js');
const { createWebApp } = await import('../src/web.js');
const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
// Three invented accounts: busy today, busy this week, busy long ago.
function account(today, history, totalMinutes) {
  const t = registry.create({ start: false });
  t.linkedAt = Date.now() - 40 * 864e5; t.ready = true; t.mode = 'connected';
  t.usage = { day: day(0), seconds: today * 60, notified: false };
  t.usageHistory = history.map(([d, m]) => ({ day: day(d), minutes: m }));
  t.totals = { own: 1, others: 0, ownSeconds: totalMinutes * 60, othersSeconds: 0, since: Date.now() - 40 * 864e5 };
  return t;
}
const todayHeavy = account(25, [[1, 1]], 30), weekHeavy = account(2, [[1, 40], [3, 40]], 90), oldHeavy = account(0, [[20, 60]], 500);
const pending = registry.create({ start: false });
const order = async (sort) => {
  const html = await (await fetch(`${base}/admin${sort ? `?sort=${sort}` : ''}`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  return [...html.matchAll(/class="arow" href="\/admin\/a\/([0-9a-f]+)"/g)].map((m) => m[1]);
};

test('sorted by minutes today, in the last 7 days, and all time: heaviest first, never-linked last', async () => {
  for (const [sort, first] of [['today', todayHeavy], ['week', weekHeavy], ['total', oldHeavy]]) {
    const ids = await order(sort);
    assert.equal(ids[0], first.id, sort);
    assert.equal(ids.at(-1), pending.id, `${sort}: a sign-up that never linked stays at the end`);
  }
  const week = await order('week');
  assert.ok(week.indexOf(todayHeavy.id) < week.indexOf(oldHeavy.id), '27 minutes this week outrank none');
});

test('the sort buttons keep the funnel period, and an unknown sort is the usual order', async () => {
  const html = await (await fetch(`${base}/admin?days=7&sort=week`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  assert.match(html, /aria-pressed="true" href="\/admin\?days=7&sort=week&f=all&page=1#accounts">7 days/);
  assert.match(html, /href="\/admin\?days=1&sort=week"/, 'the funnel periods keep the sort');
  assert.deepEqual(await order('nonsense'), await order(''));
});

test('the admin page stays English and left to right for a browser on the Hebrew site', async () => {
  const html = await (await fetch(`${base}/admin`, { headers: { cookie: 'lang=he', 'accept-language': 'he-IL', authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  assert.match(html, /<html lang="en" dir="ltr">/);
});


test('a per-account daily limit: set from the admin, kept on restart, empty goes back to the default', async () => {
  const t = registry.create({ start: false });
  const set = (v) => fetch(`${base}/admin/cap/${t.id}`, { method: 'POST', headers: { origin: base, authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: `minutes=${v}` });
  const def = t.dailyCapMinutes();
  assert.equal((await set('60')).status, 200); assert.equal(t.dailyCapMinutes(), 60);
  const { Tenant } = await import('../src/tenant.js');
  assert.equal(new Tenant(JSON.parse((await import('node:fs')).readFileSync(join(t.dir, 'tenant.json'), 'utf8')), t.dir).dailyCapMinutes(), 60);
  assert.equal((await set('abc')).status, 400); assert.equal(t.dailyCapMinutes(), 60);
  assert.equal((await set('')).status, 200); assert.equal(t.dailyCapMinutes(), def);
  // Someone stopped at the limit is let through again once it is raised.
  t.setCapMinutes(1); t.usage = { day: new Date().toISOString().slice(0, 10), seconds: 120, notified: true };
  assert.equal(t.overCap(), true); t.setCapMinutes(60); assert.equal(t.overCap(), false); assert.equal(t.usage.notified, false);
});

test('the list is 50 rows a page, searched and filtered on the server; an account opens on its own page', async () => {
  const many = Array.from({ length: 120 }, (_, i) => { const t = registry.create({ start: false }); t.linkedAt = Date.now(); t.waName = `Invented ${i}`; return t; });
  const get = async (qs) => (await fetch(`${base}/admin${qs}`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).text();
  const rows = (html) => (html.match(/class="arow"/g) || []).length;
  const first = await get('');
  assert.equal(rows(first), 50); assert.match(first, /Page 1 of 3/); assert.ok(!first.includes('Support tools'), 'no full cards on the list');
  assert.equal(rows(await get('?page=3')), registry.list().length - 100);
  const found = await get('?q=Invented%2042');
  assert.equal(rows(found), 1); assert.match(found, new RegExp(`href="/admin/a/${many[42].id}"`));
  // A search never matches across fields: "Name 4" followed by a label (or an id) that starts with 2 is not "Name 42".
  many[4].label = '2nd phone';
  assert.equal(rows(await get('?q=Invented%2042')), 1, 'the seam between a name and the next field is not searchable');
  assert.equal(rows(await get('?q=2nd%20phone')), 1, 'the label itself still is');
  assert.equal(rows(await get('?q=Invented4')), 11, 'a name written without its space still finds the name (4 and 40–49), never the seam');
  many[4].label = '';
  const waiting = await get('?f=wait');
  assert.ok(waiting.includes(`/admin/a/${pending.id}`) && !waiting.includes('Invented'), 'only sign-ups that never linked');
  const card = await get(`/a/${many[42].id}`);
  assert.match(card, /Invented 42/); assert.match(card, /Support tools/);
  assert.equal((await fetch(`${base}/admin/a/nope`, { headers: { authorization: 'Basic ' + Buffer.from('x:test-admin-pw').toString('base64') } })).status, 404);
  for (const t of many) await registry.remove(t.id);
});
