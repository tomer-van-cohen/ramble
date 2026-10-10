// node --test test/cost.test.mjs — what a recording costs: minutes of speech, tokens of chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meter, bill, chargeSpeech, chargeChat, setPrices } from '../src/cost.js';

// The table is the brain's (registered at load); here, the prices these cases reckon with.
setPrices({ 'speech-a': { minute: 0.006 }, 'speech-b': { minute: 0.0045 }, 'chat-a': { in: 0.75, cached: 0.075, out: 4.5 }, 'chat-b': { in: 2, cached: 0.1, out: 10 } });

test('a recording is billed for each transcription by the minute and each chat call by the tokens it used', async () => {
  const b = await meter(90, async () => {
    chargeSpeech('speech-a');                                                   // 1.5 min × $0.006
    await Promise.resolve();                                                             // still the same recording after an await
    chargeChat('chat-a', { prompt_tokens: 2000, completion_tokens: 1000 });       // $0.0015 + $0.0045
    return bill();
  });
  assert.ok(Math.abs(b.usd - 0.015) < 1e-9);
  assert.equal(b.unpriced, false);
});

test('an unknown model is billed at the dearer rate and marks the bill an estimate; nothing is billed outside a recording', async () => {
  const b = await meter(60, async () => { chargeSpeech('some-new-model'); return bill(); });
  assert.equal(b.unpriced, true); assert.ok(b.usd > 0);
  chargeSpeech('speech-a'); assert.equal(bill(), null);
});

test('cached input is billed at the cached price; the models we run are priced, not guessed', async () => {
  await meter(60, async () => {
    chargeSpeech('speech-b');
    chargeChat('chat-b', { prompt_tokens: 1500, prompt_tokens_details: { cached_tokens: 1200 }, completion_tokens: 400 });
    const b = bill();
    // speech 0.0045 + uncached 300×2 + cached 1200×0.1 + out 400×10, per million
    assert.ok(Math.abs(b.usd - (0.0045 + (300 * 2 + 1200 * 0.1 + 400 * 10) / 1e6)) < 1e-9, String(b.usd));
    assert.equal(b.unpriced, false);
  });
});
