/**
 * Server-wide switches an admin flips from the admin page, kept under DATA_DIR so they hold across
 * restarts and need no deploy and no change of variables (which would restart the server).
 *
 *   voiceFixAll   corrections by voice for every account, not only those turned on one by one
 *   videosAll     videos transcribed for every account (TRANSCRIBE_VIDEO=1 does the same from the env)
 *
 * And two marks, each one emoji or none (''):
 *   transcribedReaction  put on a recording whose text we posted in the chat (default 🎙️)
 *   fixReaction          put on a spoken correction once the transcript is edited (default ✏️)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from './paths.js';

export const FEATURES = ['voiceFixAll', 'videosAll'];
export const SETTINGS = { transcribedReaction: '🎙️', fixReaction: '✏️' };
// One emoji (with its modifiers and joiners), or nothing: what WhatsApp takes as a reaction.
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0F\u200D\u20E3]|\p{Emoji_Modifier}|\p{Extended_Pictographic}|\p{Regional_Indicator}){0,10}$/u;
export const validEmoji = (v) => v === '' || (typeof v === 'string' && v.length <= 32 && EMOJI.test(v));
const file = () => dataPath('features.json');
let state = null;

function load() {
  if (state) return state;
  try { state = JSON.parse(readFileSync(file(), 'utf8')) || {}; } catch { state = {}; }
  return state;
}

/** Is this server-wide switch on? */
export const feature = (name) => load()[name] === true;

/** Turn a switch on or off; returns all of them. */
export function setFeature(key, on) {
  if (!FEATURES.includes(key)) throw new Error(`no such feature: ${key}`);
  const s = load();
  s[key] = !!on;
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
  console.log(`⚙️ ${key} → ${on ? 'ON for every account' : 'off (per account only)'}`);
  return features();
}

export const features = () => Object.fromEntries(FEATURES.map((n) => [n, feature(n)]));

/** A mark's current value: what the admin set, else its default. */
export const setting = (key) => (typeof load()[key] === 'string' ? load()[key] : SETTINGS[key]);
export const settings = () => Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, setting(k)]));

/** Set a mark: one emoji, or '' for none. */
export function setSetting(key, value) {
  if (!(key in SETTINGS)) throw new Error(`no such setting: ${key}`);
  const v = String(value ?? '').trim();
  if (!validEmoji(v)) throw new Error('one emoji, or empty for none');
  const s = load();
  s[key] = v;
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
  console.log(`⚙️ ${key} → ${v || 'none'}`);
  return settings();
}
export const _reset = () => { state = null; }; // tests
