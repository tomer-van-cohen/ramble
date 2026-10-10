/**
 * What one recording cost, in US dollars, for the admin page. Counts only.
 *
 * Everything a recording triggers (transcriptions, a second reading, the rewrite, the
 * summary, a dictated message) runs inside meter(): each successful provider call adds
 * its price to that recording's bill. Speech is priced by the minute of audio sent;
 * chat by the tokens the provider reports it used. Prices are list prices, so the total
 * is a close estimate, not an invoice. The table comes from the brain (setPrices);
 * MODEL_PRICES (JSON) adds or overrides entries:
 *   {"my-stt": {"minute": 0.004}, "my-chat": {"in": 0.5, "out": 2}}   (chat: $ per 1M tokens)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

// Filled by the brain at load (its models, its prices; see brain/index.js); MODEL_PRICES wins.
const PRICES = {};
let envPrices = {};
try { envPrices = JSON.parse(process.env.MODEL_PRICES || '{}'); } catch { console.warn('MODEL_PRICES is not valid JSON; ignored'); }
/** Register a price table: { model: { minute } | { in, out, cached? } }. Later calls add or override. */
export function setPrices(table) { Object.assign(PRICES, table || {}, envPrices); }
setPrices({});
// A model we have no price for is billed like the dearest one of its kind, so the estimate errs high.
const FALLBACK = { minute: 0.006, in: 2.5, out: 15 };
const price = (model) => PRICES[model] || PRICES[String(model).split('/').pop()] || null;

const store = new AsyncLocalStorage();

/** Run fn with a bill for a recording of `seconds`; resolves to fn's result. Read the bill with bill(). */
export const meter = (seconds, fn) => store.run({ seconds, usd: 0, unpriced: false }, fn);
export const bill = () => store.getStore() || null;

/** One transcription of the current recording, by `model`. */
export function chargeSpeech(model) {
  const b = store.getStore(); if (!b) return;
  const p = price(model); if (!p?.minute) b.unpriced = true;
  b.usd += (b.seconds / 60) * (p?.minute ?? FALLBACK.minute);
}

/** One chat call, with the provider's reported token usage. */
export function chargeChat(model, usage) {
  const b = store.getStore(); if (!b || !usage) return;
  const p = price(model); if (!p?.in) b.unpriced = true;
  const prompt = Number(usage.prompt_tokens) || 0;
  const cached = p?.cached != null ? Math.min(prompt, Number(usage.prompt_tokens_details?.cached_tokens) || 0) : 0;
  b.usd += ((prompt - cached) * (p?.in ?? FALLBACK.in) + cached * (p?.cached ?? 0) + (Number(usage.completion_tokens) || 0) * (p?.out ?? FALLBACK.out)) / 1e6;
}

/** $ per minute of audio for a plan's model, speech only: for estimating minutes counted before the meter existed. */
export const speechPerMinute = (model) => price(model)?.minute ?? FALLBACK.minute;
