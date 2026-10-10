/**
 * The whole server's daily audio budget, shared by every account.
 *
 * Each account has its own daily cap, but fifty accounts at their cap would
 * still be fifty times the bill — so seconds are also reserved against one
 * process-wide ceiling before any provider is called. Kept on disk so a restart
 * does not hand out a fresh budget, and reset on the first reservation of a new
 * UTC day.
 *
 *   GLOBAL_DAILY_MINUTES   minutes of audio per day for the whole server (0 = unlimited)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dataPath } from './paths.js';

export const GLOBAL_DAILY_MINUTES = Number(process.env.GLOBAL_DAILY_MINUTES ?? 600) || 0;
const file = dataPath('budget.json');
const today = () => new Date().toISOString().slice(0, 10);

let state = (() => {
  try { const s = JSON.parse(readFileSync(file, 'utf8')); if (s?.day === today()) return s; } catch { /* none yet */ }
  return { day: today(), seconds: 0 };
})();

const save = () => { try { writeFileSync(file, JSON.stringify(state)); } catch (e) { console.warn('budget save failed:', e.message); } };
const roll = () => { if (state.day !== today()) { state = { day: today(), seconds: 0 }; save(); } };

export function secondsToday() { roll(); return state.seconds; }
export function minutesLeft() { roll(); return GLOBAL_DAILY_MINUTES > 0 ? Math.max(0, Math.round(GLOBAL_DAILY_MINUTES - state.seconds / 60)) : Infinity; }

/** Reserve seconds against the server's ceiling. Synchronous, so two jobs cannot both fit. */
export function reserve(seconds) {
  roll();
  if (GLOBAL_DAILY_MINUTES > 0 && state.seconds + seconds > GLOBAL_DAILY_MINUTES * 60) return false;
  state.seconds += seconds; save();
  return true;
}

/** Give seconds back when the work never happened (e.g. the account's own cap refused it). */
export function refund(seconds) {
  roll();
  state.seconds = Math.max(0, state.seconds - seconds); save();
}

// Test seam only.
export function __reset(day = today(), seconds = 0) { state = { day, seconds }; save(); }
