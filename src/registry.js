/**
 * All linked accounts on this server. Each lives in DATA_DIR/tenants/<id>/ with a
 * tenant.json record next to its WhatsApp session and settings.
 *
 * A single-account installation from before multi-tenancy (session and settings
 * directly in DATA_DIR) is moved into tenants/default/ on first boot, keeping
 * its session and control group.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';
import { Tenant } from './tenant.js';
import { defaults as defaultSettings } from './settings.js';
import * as visitors from './visitors.js';

export const tenantsDir = join(dataDir, 'tenants');
export const MAX_TENANTS = Number(process.env.MAX_TENANTS ?? 50);
const LEGACY_ITEMS = ['baileys_auth', 'target.json', 'muted.json', 'enabled.json', 'archived.json', 'fwdmap.json', 'mediasrc.json', 'contacts.json', 'glossary.json', 'appstate-resync.json', 'media'];

const tenants = new Map();
const newId = () => randomBytes(16).toString('hex');
const newInviteCode = () => randomBytes(4).toString('hex'); // public, short, shareable
export const INVITE_RE = /^[0-9a-f]{8}$/;

export function migrateLegacy() {
  const legacyAuth = join(dataDir, 'baileys_auth');
  const target = join(tenantsDir, 'default');
  if (!existsSync(legacyAuth) || existsSync(target)) return false;
  mkdirSync(target, { recursive: true });
  for (const item of LEGACY_ITEMS) {
    const from = join(dataDir, item);
    if (existsSync(from)) renameSync(from, join(target, item));
  }
  const rec = { id: 'default', label: process.env.OWNER_NAME && process.env.OWNER_NAME !== 'me' ? process.env.OWNER_NAME : 'owner', language: process.env.TRANSCRIBE_LANGUAGE || '', createdAt: Date.now() };
  writeFileSync(join(target, 'tenant.json'), JSON.stringify(rec, null, 2));
  console.log('📦 Migrated the single-account installation into tenants/default (session and control group kept).');
  return true;
}

export function loadAll() {
  mkdirSync(tenantsDir, { recursive: true });
  for (const dirName of readdirSync(tenantsDir)) {
    const dir = join(tenantsDir, dirName);
    const recFile = join(dir, 'tenant.json');
    if (!existsSync(recFile)) continue;
    try {
      const rec = JSON.parse(readFileSync(recFile, 'utf8'));
      const t = new Tenant(rec, dir);
      if (!t.inviteCode) { t.inviteCode = newInviteCode(); t.persistRecord(); } // accounts created before invites existed
      wire(t);
      tenants.set(rec.id, t);
    } catch (e) { console.warn(`tenant ${dirName}: bad record (${e.message})`); }
  }
  return [...tenants.values()];
}

/** Start every loaded tenant, a couple of seconds apart, so a restart isn't a burst. */
export async function startAll() {
  // All at once here; the connection gate lets a few through at a time, in this order. Whoever linked
  // most recently goes first: a device that vanishes minutes after linking is the one WhatsApp drops.
  const newestFirst = [...tenants.values()].sort((a, b) => (b.linkedAt || b.createdAt || 0) - (a.linkedAt || a.createdAt || 0));
  for (const t of newestFirst) t.start().catch((e) => console.error(`${t.tag} start failed:`, e.message));
  setInterval(expireUnlinked, 5 * 60 * 1000).unref?.();
}

// Sign-ups that never scanned the QR would otherwise sit reconnecting forever.
export const UNLINKED_TTL_MIN = Number(process.env.UNLINKED_TTL_MINUTES ?? 30);
export async function expireUnlinked() {
  const cutoff = Date.now() - UNLINKED_TTL_MIN * 60e3;
  for (const t of [...tenants.values()]) {
    if (!t.linkedAt && t.createdAt < cutoff) {
      console.log(`${t.tag} ⌛ never linked within ${UNLINKED_TTL_MIN} min — removed`);
      await remove(t.id).catch((e) => console.warn(`${t.tag} expire failed:`, e.message));
    }
  }
}

// Sign-ups that have not scanned yet. Capped separately so a burst of fake
// sign-ups cannot reserve the whole server's capacity.
export const MAX_PENDING = Number(process.env.MAX_PENDING ?? 10);
export const pendingCount = () => [...tenants.values()].filter((t) => !t.linkedAt).length;

/** The account whose invite link was used, if the code is one we know. */
export const byInvite = (code) => (INVITE_RE.test(String(code || '')) ? [...tenants.values()].find((t) => t.inviteCode === code) || null : null);

/** Credit whoever invited this account, the first time it links. */
function creditReferrer(t) {
  const r = t.referredBy ? byInvite(t.referredBy) : null;
  if (r && r.id !== t.id) r.creditInvite();
}

// What an account can ask of the registry: credit its inviter, and erase itself ("leave" in WhatsApp).
function wire(t) {
  t.onFirstLink = (me) => { creditReferrer(me); const v = signupOf(me)?.visitor; if (v) visitors.markLinked(v); };
  t.onLeave = (me) => remove(me.id).catch((e) => console.warn(`${me.tag} leave failed:`, e.message));
}

export function create({ language = '', locale = '', label = '', plan = undefined, referredBy = '', signup = null, start = true } = {}) {
  if (tenants.size >= MAX_TENANTS) throw Object.assign(new Error('This server is full right now. Please try again later.'), { why: 'full' });
  if (pendingCount() >= MAX_PENDING) throw Object.assign(new Error('Too many sign-ups are waiting to be linked right now. Please try again in a few minutes.'), { why: 'waiting' });
  const rec = { id: newId(), label: String(label).slice(0, 60), language: String(language).slice(0, 5), ...(locale === 'he' || locale === 'en' ? { locale } : {}), createdAt: Date.now(), settings: defaultSettings(), inviteCode: newInviteCode(), ...(byInvite(referredBy) ? { referredBy } : {}), ...(plan ? { plan } : {}) };
  const dir = join(tenantsDir, rec.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'tenant.json'), JSON.stringify(rec, null, 2), { mode: 0o600 });
  if (signup) writeFileSync(join(dir, 'signup.json'), JSON.stringify(signup), { mode: 0o600 });
  const t = new Tenant(rec, dir);
  wire(t);
  tenants.set(rec.id, t);
  if (start) t.start().catch((e) => console.error(`${t.tag} start failed:`, e.message)); // start:false = tests, no network
  console.log(`${t.tag} 🆕 account created (language: ${rec.language || 'auto'})`);
  return t;
}

export const get = (id) => tenants.get(id) || null;

/** Where a sign-up came from (address, device, browser language…), for the admin page. Erased with the account. */
// Read once per account: it is written only at sign-up, and the admin page asks for every account at once.
const signups = new Map();
export function signupOf(t) {
  if (!signups.has(t.id)) { let v = null; try { v = JSON.parse(readFileSync(join(t.dir, 'signup.json'), 'utf8')); } catch { /* none */ } signups.set(t.id, v); }
  return signups.get(t.id);
}

export const list = () => [...tenants.values()];

/** Unlink the WhatsApp session and erase everything about this account. */
export async function remove(id) {
  const t = tenants.get(id);
  if (!t) return false;
  tenants.delete(id); signups.delete(id);
  const r = await t.stop({ logout: true });
  rmSync(t.dir, { recursive: true, force: true });
  console.log(`${t.tag} 🗑️ account erased; WhatsApp logout ${r?.loggedOut ? 'confirmed' : 'NOT confirmed'}`);
  return { removed: true, loggedOut: !!r?.loggedOut };
}
