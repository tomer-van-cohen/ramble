// node --test test/phone.test.mjs — the number for a pairing code, the way people type it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'ramble-phone-'));
process.env.TRUST_PROXY = '0';
const { normalizePhone, countryFromLanguage, COUNTRIES } = await import('../src/pairing.js');
const registry = await import('../src/registry.js');
const { startSession } = await import('../src/door.js');
const { createWebApp } = await import('../src/web.js');

test('a local number gets the chosen country in front; its trunk 0 goes', () => {
  assert.equal(normalizePhone('050-123 4567', '972'), '972501234567', 'what the phone autofills');
  assert.equal(normalizePhone('501234567', '972'), '972501234567');
  assert.equal(normalizePhone('07700 900123', '44'), '447700900123');
  assert.equal(normalizePhone('691 234 5678', '30'), '306912345678', 'no trunk 0 in Greece: nothing to strip');
  assert.equal(normalizePhone('(415) 555-0100', '1'), '14155550100');
  assert.equal(normalizePhone('312 345 6789', '39'), '393123456789');
});

test('a number typed with its country code is taken as it is, whatever country is picked', () => {
  assert.equal(normalizePhone('+30 691 234 5678', '972'), '306912345678');
  assert.equal(normalizePhone('0030 691 234 5678', '972'), '306912345678');
  assert.equal(normalizePhone('972 50 123 4567', '972'), '972501234567', 'the code without its plus');
  assert.equal(normalizePhone('+972501234567'), '972501234567');
  for (const bad of ['050', '', 'abc', '+0501234567']) assert.equal(normalizePhone(bad, '972'), null, JSON.stringify(bad));
});

test('the browser language points at a country; English alone does not', () => {
  assert.equal(countryFromLanguage('he-IL,he;q=0.9,en;q=0.8'), 'IL');
  assert.equal(countryFromLanguage('he'), 'IL');
  assert.equal(countryFromLanguage('el'), 'GR');
  assert.equal(countryFromLanguage('en-GB'), 'GB');
  assert.equal(countryFromLanguage('en'), '');
  for (const [iso, dial, name, zones] of COUNTRIES) assert.ok(/^[A-Z]{2}$/.test(iso) && /^\d{1,3}$/.test(dial) && name && zones.length, iso);
});

const server = createWebApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

test('the code form sends the country with the number, and the server puts them together', async () => {
  const t = registry.create({ start: false });
  const cookie = `rl=${t.id}.${startSession(t)}`;
  const post = (body) => fetch(`${base}/link/${t.id}/code`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  assert.equal((await post('phone=050-123%204567&cc=972')).status, 303); assert.equal(t.pairPhone, '972501234567');
  assert.equal((await post('phone=%2B30%20691%20234%205678&cc=972')).status, 303); assert.equal(t.pairPhone, '306912345678');
  assert.equal((await post('phone=050&cc=972')).status, 400);
  const html = await (await fetch(`${base}/link/${t.id}?via=code`, { headers: { cookie, 'accept-language': 'he-IL,he;q=0.9' } })).text();
  assert.match(html, /c\[0\]==='IL'\)\|\|countries\.find\(c=>c\[3\]\.includes\(tz\)\)/, 'Hebrew outranks the time zone');
  const en = await (await fetch(`${base}/link/${t.id}?via=code`, { headers: { cookie, 'accept-language': 'en-US,en;q=0.9' } })).text();
  assert.match(en, /c\[0\]===''\)\|\|countries\.find\(c=>c\[3\]\.includes\(tz\)\)/, 'English: the time zone decides');
  assert.match(html, /data-copy=/, 'the code screen has a copy button');
  await registry.remove(t.id);
});
