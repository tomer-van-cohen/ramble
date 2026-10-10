// node --test test/phonebrake.test.mjs — requests to the owner's phone to resend a message are capped per hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeholderCache } from '../src/phonebrake.js';

// The library's own sequence for one request: ask the cache, record the request, check again after a delay.
const ask = (c, id) => { if (c.get(id)) return false; c.set(id, { key: { id } }); return true; };

test('up to the hourly cap the phone is asked; beyond it the cache says "already asked", once warned', () => {
  let t = 0; const held = [];
  const c = placeholderCache({ perHour: 3, now: () => t, onHeld: (x) => held.push(x) });
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map((id) => ask(c, id)), [true, true, true, false, false]);
  assert.equal(c.held, 2); assert.equal(held.length, 1, 'one line an hour, not one per message');
  t += 3600e3;
  assert.equal(ask(c, 'f'), true, 'a new hour, new requests');
});

test('a request already out is still found, answered and cleared, whatever the cap', () => {
  let t = 0; const c = placeholderCache({ perHour: 1, now: () => t });
  assert.equal(ask(c, 'a'), true);
  assert.deepEqual(c.get('a'), { key: { id: 'a' } }, 'the answer handler reads what was kept');
  c.del('a');
  assert.equal(c.get('b'), true, 'the hour\'s one request is spent');
});

test('the default: the phone is never asked, and that is said once an hour', async () => {
  const { PHONE_REQUESTS_PER_HOUR } = await import('../src/phonebrake.js');
  assert.equal(PHONE_REQUESTS_PER_HOUR, 0);
  let t = 0; const held = [];
  const c = placeholderCache({ now: () => t, onHeld: (x) => held.push(x) });
  assert.ok(Array.from({ length: 50 }, (_, i) => ask(c, `m${i}`)).every((x) => x === false));
  assert.equal(held.length, 1); assert.equal(held[0].perHour, 0);
});
