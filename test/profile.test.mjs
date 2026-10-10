// node --test test/profile.test.mjs — reading V8's sampling profiles into two log lines (pure parts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topCpu, topLive } from '../src/profile.js';

const cf = (functionName, url, lineNumber = 0) => ({ functionName, url, lineNumber });

test('cpu: functions are ranked by their own time; idle time is left out', () => {
  const profile = { startTime: 0, endTime: 1000, nodes: [{ id: 1, callFrame: cf('(idle)', '') }, { id: 2, callFrame: cf('decode', 'file:///app/node_modules/protobufjs/src/reader.js', 9) }, { id: 3, callFrame: cf('save', 'file:///app/src/tenant.js', 88) }], samples: [1, 2, 2, 3, 2], timeDeltas: [400, 200, 200, 100, 100] };
  assert.deepEqual(topCpu(profile), ['decode protobufjs/src/reader.js:10 50.0%', 'save src/tenant.js:89 10.0%']);
});

test('live memory: bytes are charged to where they were allocated, with the caller that asked', () => {
  const head = { callFrame: cf('(root)', ''), selfSize: 0, children: [{ callFrame: cf('onMessage', 'file:///app/src/tenant.js', 500), selfSize: 0, children: [
    { callFrame: cf('set', 'file:///app/node_modules/lru-cache/dist/esm/index.js', 40), selfSize: 3e6, children: [] },
    { callFrame: cf('push', '', 0), selfSize: 1e6, children: [] }] }] };
  const live = topLive(head);
  assert.equal(live.totalMb, 4);
  assert.deepEqual(live.top, ['set lru-cache/dist/esm/index.js:41 ← onMessage src/tenant.js:501 3MB', 'push (native):1 ← onMessage src/tenant.js:501 1MB']);
});
