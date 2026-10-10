// node --test test/pairing.test.mjs — the QR always carries the adv secret in force; a refresh rotates it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attach, withAdvSecret, rotateAdvSecret, normalizePhone } from '../src/pairing.js';

const fakeSocket = () => { const s = { ev: new EventEmitter(), ws: new EventEmitter(), authState: { creds: { advSecretKey: 'OLD=' } }, sent: [] }; s.sendNode = async (n) => { s.sent.push(n); }; return s; };

test('a QR from Baileys is shown with the current secret; a companion_reg_refresh rotates it, shows the same ref again and is acknowledged', async () => {
  const sock = fakeSocket(); const shown = []; const saved = [];
  sock.ev.on('creds.update', (c) => saved.push(c.advSecretKey));
  let refreshed = 0;
  attach(sock, { onQr: (q) => shown.push(q), onRefresh: () => refreshed++, log: () => {} });
  sock.ev.emit('connection.update', { qr: 'ref1,NOISE,IDENT,OLD=' });
  assert.deepEqual(shown, ['ref1,NOISE,IDENT,OLD=']);
  sock.ws.emit('CB:notification,type:companion_reg_refresh', { tag: 'notification', attrs: { id: 'n1', from: 's.whatsapp.net', type: 'companion_reg_refresh' } });
  await new Promise((r) => setImmediate(r));
  const fresh = sock.authState.creds.advSecretKey;
  assert.deepEqual(sock.sent, [{ tag: 'ack', attrs: { id: 'n1', to: 's.whatsapp.net', class: 'notification', type: 'companion_reg_refresh' } }], 'acknowledged, as WhatsApp Web does');
  assert.notEqual(fresh, 'OLD='); assert.equal(Buffer.from(fresh, 'base64').length, 32);
  assert.deepEqual(saved, [fresh], 'persisted through creds.update');
  assert.equal(shown[1], `ref1,NOISE,IDENT,${fresh}`, 'same ref, new secret — no QR from the pool spent');
  assert.equal(refreshed, 1, 'the page is told: the phone has to scan again');
  // Baileys keeps rotating refs with the secret it captured at the start; every one is corrected.
  sock.ev.emit('connection.update', { qr: 'ref2,NOISE,IDENT,OLD=' });
  assert.equal(shown[2], `ref2,NOISE,IDENT,${fresh}`);
  sock.ev.emit('connection.update', { connection: 'open' });
  assert.equal(shown.length, 3, 'nothing shown for an update without a QR');
});

test('helpers: an unexpected QR shape passes through; rotation is random', () => {
  assert.equal(withAdvSecret('weird', 'x'), 'weird');
  const sock = fakeSocket(); const a = rotateAdvSecret(sock), b = rotateAdvSecret(sock);
  assert.notEqual(a, b); assert.equal(sock.authState.creds.advSecretKey, b);
});

test('a phone number is digits with the country code, nothing else', () => {
  assert.equal(normalizePhone('+972 50-123 4567'), '972501234567');
  assert.equal(normalizePhone('00972501234567'), '972501234567');
  assert.equal(normalizePhone('(1) 415 555 0100'), '14155550100');
  for (const bad of ['', '0501234567x', '05', '1234567', '0'.repeat(12), '9'.repeat(16), 'abc']) assert.equal(normalizePhone(bad), null, JSON.stringify(bad));
});

test('on a registered session Baileys acks itself: nothing is sent from here', async () => {
  const sock = fakeSocket(); sock.authState.creds.me = { id: '1@s.whatsapp.net' };
  attach(sock, { log: () => {} });
  sock.ws.emit('CB:notification,type:companion_reg_refresh', { tag: 'notification', attrs: { id: 'n2' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sock.sent, []);
});

