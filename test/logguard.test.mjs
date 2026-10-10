// node --test test/logguard.test.mjs — the Signal library's session dumps never reach a log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screen, looksLikeKeys } from '../src/logguard.js';

class SessionEntry { constructor() { this._chains = {}; this.currentRatchet = { rootKey: Buffer.alloc(32, 1), ephemeralKeyPair: { privKey: Buffer.alloc(32, 2) } }; } }

test('a session dump from the Signal library prints nothing', () => {
  assert.equal(screen(['Closing session:', new SessionEntry()]), null);
  assert.equal(screen(['Opening session:', new SessionEntry()]), null);
  assert.equal(screen(['Removing old closed session:', new SessionEntry()]), null);
});

test('a decrypt problem keeps its one line of text and nothing else', () => {
  assert.deepEqual(screen(['Closing open session in favor of incoming prekey bundle']), ['Closing open session in favor of incoming prekey bundle']);
  assert.deepEqual(screen(['Session error:Error: Bad MAC\n    at x', new Error('Bad MAC')]), ['Session error:Error: Bad MAC']);
});

test('key material is withheld whoever logs it; ordinary lines pass untouched', () => {
  assert.deepEqual(screen(['state', { privKey: Buffer.alloc(32) }]), ['state', '[session keys withheld]']);
  assert.equal(looksLikeKeys(new SessionEntry()), true);
  const line = ['[abc123] 🎙️ 9s → 100 chars [pro]'];
  assert.deepEqual(screen(line), line);
  assert.deepEqual(screen(['count', 3, { ok: true }]), ['count', 3, { ok: true }]);
});

test('the console itself is guarded once the module is loaded', async () => {
  const seen = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c, ...r) => { seen.push(String(c)); return true; };
  try { console.info('Closing session:', new SessionEntry()); console.log('fine'); }
  finally { process.stdout.write = orig; }
  assert.equal(seen.join(''), 'fine\n');
});
