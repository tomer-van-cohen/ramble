/**
 * What an account transcribes, and where the text goes: the settings page's model.
 *
 * Two sections, private chats and groups, each with:
 *   on    — transcribe in this kind of chat at all
 *   who   — 'mine' (the owner's own voice notes), 'others' (everyone's but the owner's) or 'all'
 *   where — 'chat' (the text under the recording, for everyone in the chat) or
 *           'me' (the text only in the owner's Ramble group)
 *   some  — chat ids: when not empty, only these chats are transcribed
 *
 * The page shows one "where" for both sections and sets both; an account from
 * before the page may have them apart ("groups private"), and the page says so.
 * Per-chat switches from WhatsApp (include / exclude / private) sit on top.
 */

export const WHO = ['mine', 'others', 'all'];
export const WHERE = ['chat', 'me'];
export const SECTIONS = ['chats', 'groups'];
const MAX_SOME = 300;
// A private chat is a phone id or a lid; a group is a group id. Nothing else is ever stored.
const ID_RE = { chats: /^\d{1,20}@(s\.whatsapp\.net|lid)$/, groups: /^\d[\d-]{0,40}@g\.us$/ };

/** A new account: everyone's voice notes in private chats, the owner's own in groups, the text in the chat. */
export const defaults = () => ({
  chats: { on: true, who: 'all', where: 'chat', some: [] },
  groups: { on: true, who: 'mine', where: 'chat', some: [] },
});

/**
 * An account from before the page: private chats were always on, for everyone, in the chat;
 * groups followed the "groups" command ('off' | 'mine' | 'private', none on record = 'mine').
 */
export function fromLegacy(groups) {
  const s = defaults();
  if (groups === 'off') s.groups.on = false;
  else if (groups === 'private') Object.assign(s.groups, { who: 'all', where: 'me' });
  return s;
}

/** The settings as kept in the account's record, or what its old "groups" setting meant. */
export const readSettings = (rec = {}) => (rec.settings && typeof rec.settings === 'object' ? applyPatch(defaults(), rec.settings) : fromLegacy(rec.groups));

/**
 * A change from the page (or the record on disk), checked field by field: anything that is not
 * a known value is ignored, never stored. `where` alone sets both sections.
 */
export function applyPatch(cur, patch = {}) {
  const next = { chats: { ...cur.chats, some: [...cur.chats.some] }, groups: { ...cur.groups, some: [...cur.groups.some] } };
  if (WHERE.includes(patch?.where)) for (const k of SECTIONS) next[k].where = patch.where;
  for (const k of SECTIONS) {
    const p = patch?.[k];
    if (!p || typeof p !== 'object') continue;
    if (typeof p.on === 'boolean') next[k].on = p.on;
    if (WHO.includes(p.who)) next[k].who = p.who;
    if (WHERE.includes(p.where)) next[k].where = p.where;
    if (Array.isArray(p.some)) next[k].some = [...new Set(p.some.filter((id) => typeof id === 'string' && ID_RE[k].test(id)))].slice(0, MAX_SOME);
  }
  return next;
}

/** The one "where" the page shows: both sections agree, or 'mixed'. */
export const whereOf = (s) => (s.chats.where === s.groups.where ? s.chats.where : 'mixed');

/**
 * One recording in a chat of this section that no per-chat switch covers: null (not transcribed),
 * 'chat' or 'me'. `chosen`: the chat is among `some` (or there is no list).
 */
export function decide(section, { fromMe, chosen = true }) {
  if (!section.on) return null;
  if (section.some.length && !chosen) return null;
  if (!fromMe && section.who === 'mine') return null;
  if (fromMe && section.who === 'others') return null;
  return section.where;
}

/**
 * The groups section in the words of the "groups" command: off, mine, others, all (in the group), private
 * (everyone's, to me) — or mine-private / others-private (to me), which only the page sets.
 */
export const groupsMode = (s) => (!s.groups.on ? 'off' : s.groups.where === 'me' ? (s.groups.who === 'all' ? 'private' : `${s.groups.who}-private`) : s.groups.who);
/** The "groups" command: the groups section only, the chosen groups kept. */
export function setGroupsMode(s, mode) {
  const g = { off: { on: false }, mine: { on: true, who: 'mine', where: 'chat' }, others: { on: true, who: 'others', where: 'chat' }, all: { on: true, who: 'all', where: 'chat' }, private: { on: true, who: 'all', where: 'me' } }[mode];
  return g ? applyPatch(s, { groups: g }) : s;
}
/**
 * What a server from before the page would make of these settings (written alongside, so a rollback keeps the
 * safe meaning: nothing posted that wasn't wanted). It had no "others only": that rolls back to off.
 */
export const legacyGroups = (s) => ({ off: 'off', others: 'off', private: 'private', 'mine-private': 'private', 'others-private': 'private' }[groupsMode(s)] || 'mine');

// ---------- the link the "settings" command sends ----------
// The site's own address, for links sent into WhatsApp: set explicitly, or the one Railway gives the service.
const host = process.env.CANONICAL_HOST || process.env.RAILWAY_PUBLIC_DOMAIN || '';
export const SITE_URL = (process.env.PUBLIC_URL || (host ? `https://${host}` : '')).replace(/\/+$/, '');
// The address alone opens nothing: a browser that is not signed in shows a code to send in the control group (door.js).
/** welcome: the link in the welcome message; the page opens with its welcome. */
export const settingsUrl = (id, { welcome = false } = {}) => (!SITE_URL ? '' : `${SITE_URL}/settings/${id}${welcome ? '?welcome=1' : ''}`);
