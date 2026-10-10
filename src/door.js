/**
 * Who may open an account's private pages (the link page, settings): the browsers it signed in.
 *
 * Each browser holds its own session token in an HttpOnly cookie; the account keeps only a hash of it.
 * A browser gets one by signing up, by a support link from the operator (an entry token, good for a
 * day), or at the settings page's door: the page shows a three-digit code, and the owner sends it in
 * their control group, where nobody else can write. A forwarded link alone therefore opens nothing.
 */
import { randomBytes, createHash } from 'node:crypto';

export const TOKEN_RE = /^[0-9a-f]{32}$/;
export const DOOR_RE = /^[0-9a-f]{20}$/;
export const MAX_SESSIONS = 20;          // the oldest is dropped beyond that; nobody has twenty browsers
export const CODE_TTL_MS = 10 * 60e3;
export const ENTRY_TTL_MS = 24 * 3600e3;
const MAX_DOORS = 5;                     // codes waiting at once, per account

const hash = (token) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(16).toString('hex');

/** Sessions as stored: a list of { h: hash, at }; anything else is dropped. */
export const readSessions = (v) => (Array.isArray(v) ? v.filter((s) => s && /^[0-9a-f]{64}$/.test(s.h)).slice(-MAX_SESSIONS) : []);

/** A new session for this account. The token goes into the browser's cookie and is never kept. */
export function startSession(t, now = Date.now()) {
  const token = newToken();
  t.sessions = [...t.sessions, { h: hash(token), at: now }].slice(-MAX_SESSIONS);
  t.persistRecord();
  return token;
}
export const hasSession = (t, token) => TOKEN_RE.test(token || '') && t.sessions.some((s) => s.h === hash(token));

/** Support: every browser is signed out, and a link that signs one in for a day is returned. */
export function issueEntry(t, now = Date.now()) {
  const token = newToken();
  t.sessions = []; t.entry = { h: hash(token), exp: now + ENTRY_TTL_MS };
  t.persistRecord();
  forget(t.id);
  return token;
}
export const useEntry = (t, token, now = Date.now()) => TOKEN_RE.test(token || '') && !!t.entry && t.entry.exp > now && t.entry.h === hash(token);

// ---------- the door: a code shown in the browser, sent by the owner in WhatsApp ----------
// Kept in memory only: a code lives ten minutes, and after a restart the page simply shows a new one.
const doors = new Map(); // account id → Map(door id → { code, exp, device, token })
const doorsOf = (id, now) => {
  const m = doors.get(id) || new Map();
  for (const [k, d] of m) if (d.exp <= now) m.delete(k);
  doors.set(id, m);
  return m;
};
export const forget = (id) => doors.delete(id);

/** This browser's code: the one it already waits with, else a new one, unlike any other waiting. */
export function openDoor(t, doorId, device, now = Date.now()) {
  const m = doorsOf(t.id, now);
  const mine = DOOR_RE.test(doorId || '') ? m.get(doorId) : null;
  if (mine && !mine.token) return { id: doorId, code: mine.code };
  while (m.size >= MAX_DOORS) m.delete(m.keys().next().value);
  const taken = new Set([...m.values()].map((d) => d.code));
  let code;
  do code = String(100 + (randomBytes(2).readUInt16BE() % 900)); while (taken.has(code));
  const id = randomBytes(10).toString('hex');
  m.set(id, { code, exp: now + CODE_TTL_MS, device, token: null });
  return { id, code };
}

/** The owner sent three digits in the control group: the device it opened, or null if no browser waits with them. */
export function answerDoor(t, text, now = Date.now()) {
  const d = [...doorsOf(t.id, now).values()].find((x) => !x.token && x.code === text);
  if (!d) return null;
  d.token = startSession(t, now);
  return d.device;
}

/** What the waiting page learns: 'waiting', 'open' (with the session token, handed over once) or 'gone'. */
export function doorState(t, doorId, now = Date.now()) {
  const m = doorsOf(t.id, now);
  const d = DOOR_RE.test(doorId || '') ? m.get(doorId) : null;
  if (!d) return { state: 'gone' };
  if (!d.token) return { state: 'waiting' };
  m.delete(doorId);
  return { state: 'open', token: d.token };
}
