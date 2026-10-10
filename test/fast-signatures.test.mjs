// node --test test/fast-signatures.test.mjs — the Signal library's signatures go through the Rust/WASM bridge
// (scripts/patch-deps.mjs). The bridge and the pure-JS code it replaces must agree both ways, and forgeries
// must be refused, or the patch is not safe. Invented keys and messages; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const curve = require('libsignal/src/curve.js');     // patched: the bridge
const curveJs = require('curve25519-js');            // the pure-JS reference
const N = 400;
const PREFIX = Buffer.from([5]);

test('the patch is in place: signatures go through the bridge', () => {
  assert.equal(curve.fastSignatures, true, 'run `node scripts/patch-deps.mjs`');
});

test(`${N} random keys and messages: what one signs the other verifies, both ways`, () => {
  for (let i = 0; i < N; i++) {
    const kp = curveJs.generateKeyPair(randomBytes(32));
    const priv = Buffer.from(kp.private), pub = Buffer.concat([PREFIX, Buffer.from(kp.public)]);
    const msg = randomBytes(1 + (i % 300));
    const sigJs = Buffer.from(curveJs.sign(kp.private, msg));
    const sigFast = curve.calculateSignature(priv, msg);
    assert.equal(sigFast.length, 64);
    assert.equal(curve.verifySignature(pub, msg, sigJs), true, 'JS-signed, bridge-verified');
    assert.equal(curveJs.verify(kp.public, msg, sigFast), true, 'bridge-signed, JS-verified');
  }
});

test('a changed message, another key or a damaged signature is refused, every time', () => {
  for (let i = 0; i < N; i++) {
    const kp = curveJs.generateKeyPair(randomBytes(32)), other = curveJs.generateKeyPair(randomBytes(32));
    const pub = Buffer.concat([PREFIX, Buffer.from(kp.public)]);
    const msg = randomBytes(40 + (i % 200));
    const sig = curve.calculateSignature(Buffer.from(kp.private), msg);
    const changed = Buffer.from(msg); changed[i % changed.length] ^= 1;
    assert.equal(curve.verifySignature(pub, changed, sig), false, 'changed message');
    assert.equal(curve.verifySignature(Buffer.concat([PREFIX, Buffer.from(other.public)]), msg, sig), false, 'another key');
    const damaged = Buffer.from(sig); damaged[i % 64] ^= 1 << (i % 8);
    assert.equal(curve.verifySignature(pub, msg, damaged), false, 'damaged signature');
  }
});

test('the keys the library really makes (x25519 from node:crypto) sign and verify the same way', () => {
  for (let i = 0; i < 50; i++) {
    const kp = curve.generateKeyPair();
    const msg = randomBytes(100);
    const sig = curve.calculateSignature(kp.privKey, msg);
    assert.equal(curve.verifySignature(kp.pubKey, msg, sig), true);
    assert.equal(curveJs.verify(kp.pubKey.subarray(1), msg, sig), true, 'the pure-JS code accepts it too');
    assert.equal(curve.verifySignature(kp.pubKey, msg, Buffer.from(curveJs.sign(kp.privKey, msg))), true, 'and the other way round');
  }
});

test('the library\'s own checks still come first: a bad key or a short signature throws, as before', () => {
  const kp = curve.generateKeyPair();
  assert.throws(() => curve.verifySignature(kp.pubKey, randomBytes(10), randomBytes(63)), /Invalid signature/);
  assert.throws(() => curve.verifySignature(Buffer.alloc(10), randomBytes(10), randomBytes(64)), /Invalid public key/);
  assert.throws(() => curve.calculateSignature(Buffer.alloc(31), randomBytes(10)), /Incorrect private key length/);
});
