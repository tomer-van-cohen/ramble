/**
 * Where one account's WhatsApp session lives: its credentials and every Signal key,
 * in a single SQLite file (DATA_DIR/tenants/<id>/auth.db).
 *
 * Baileys' own useMultiFileAuthState writes one file per key. An account that has seen a
 * few thousand people holds tens of thousands of them, and a volume runs out of inodes
 * long before it runs out of space; after that no key can be saved at all. Here a key is
 * a row, a batch of keys is one transaction (all of it lands or none of it), and an
 * account is three files however long it lives.
 *
 * An account that still has the old folder (baileys_auth/) is moved over the first time
 * it starts: every readable file becomes a row under the same name, byte for byte. The folder is
 * set aside, and deleted once WhatsApp has accepted a connection made from the new store.
 * Only code older than this file writes baileys_auth/, so if that folder is there it is
 * the newer truth and is imported again.
 *
 * One store per account, open for as long as the account runs. auth() gives a socket what
 * useMultiFileAuthState would: { state: { creds, keys: { get, set } }, saveCreds }, with the
 * credentials read afresh, so every reconnect starts from what was saved. settle() drops the
 * set-aside folder, clear() forgets everything (logged out), close() ends it (account stopped).
 */
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initAuthCreds, BufferJSON, proto, useMultiFileAuthState } from '@whiskeysockets/baileys';

// node:sqlite ships with Node 22.13+. Without it the old store still works.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* older Node */ }
export const sqliteAvailable = Boolean(DatabaseSync);

const OLD_DIR = 'baileys_auth';
const SET_ASIDE = 'baileys_auth.migrated';
const DB_FILE = 'auth.db';
// The names the old store gave its files; rows keep them, so a moved key is found where it was.
const rowName = (file) => file.replace(/\//g, '__').replace(/:/g, '-');
const READ_BATCH = 200;

/** Every *.json file of the old folder as [name, text]. Read a few hundred at a time: this runs while the site is serving. */
async function readOldFolder(dir) {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const rows = [];
  for (let i = 0; i < names.length; i += READ_BATCH) {
    rows.push(...await Promise.all(names.slice(i, i + READ_BATCH).map(async (f) => [f, await readFile(join(dir, f), 'utf8')])));
  }
  return rows;
}

/** @param {string} dir the account's directory @param {{ tag?: string }} [o] */
export async function useAuthStore(dir, { tag = '' } = {}) {
  const oldDir = join(dir, OLD_DIR), setAside = join(dir, SET_ASIDE);
  if (!sqliteAvailable) {
    console.warn(`${tag} ⚠️ this Node has no built-in SQLite — session keys stay one file each (needs Node 22.13+)`);
    return { auth: () => useMultiFileAuthState(oldDir), settle: async () => {}, close: () => {}, clear: async () => { await rm(oldDir, { recursive: true, force: true }); } };
  }

  mkdirSync(dir, { recursive: true });
  let db = new DatabaseSync(join(dir, DB_FILE));
  // WAL: a commit is an append, not a rewrite. A small page cache, because there is one of these per account.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-256; PRAGMA secure_delete=ON;');
  db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID');
  const q = {
    get: db.prepare('SELECT v FROM kv WHERE k = ?'),
    put: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    del: db.prepare('DELETE FROM kv WHERE k = ?'),
  };
  const transaction = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try { work(); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* nothing open */ } throw e; }
  };

  if (existsSync(oldDir)) {
    const all = await readOldFolder(oldDir);
    // A file that is not JSON (a write cut short by a crash) read as "no such key" in the old store; it does here too.
    const rows = all.filter(([, text]) => { try { JSON.parse(text); return true; } catch { return false; } });
    transaction(() => { db.exec('DELETE FROM kv'); for (const [name, text] of rows) q.put.run(name, text); });
    const moved = db.prepare('SELECT COUNT(*) AS n FROM kv').get().n;
    if (moved !== rows.length) throw new Error(`session move incomplete: ${moved} of ${rows.length} keys`);
    if (rows.length < all.length) console.warn(`${tag} ⚠️ ${all.length - rows.length} damaged key file(s) were left out of the move`);
    await rm(setAside, { recursive: true, force: true });
    await rename(oldDir, setAside);
    console.log(`${tag} 📦 session moved into one file (${rows.length} keys); the old folder goes once WhatsApp accepts the connection`);
  }

  const read = (name) => {
    if (!db) return null;
    const row = q.get.get(rowName(name));
    if (!row) return null;
    try { return JSON.parse(row.v, BufferJSON.reviver); } catch { return null; }
  };
  const keys = {
    get: async (type, ids) => {
      const data = {};
      for (const id of ids) {
        let value = read(`${type}-${id}.json`);
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        data[id] = value;
      }
      return data;
    },
    set: async (data) => {
      if (!db) return; // the account was stopped; nothing of it is written any more
      transaction(() => {
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id], name = rowName(`${category}-${id}.json`);
            if (value) q.put.run(name, JSON.stringify(value, BufferJSON.replacer)); else q.del.run(name);
          }
        }
      });
    },
  };

  return {
    auth: async () => {
      let creds = read('creds.json');
      if (!creds) {
        // No credentials: this is a fresh pairing, and it gets a new identity. Sessions and sender
        // keys left by an earlier identity would be used to encrypt what nobody can then decrypt.
        const stale = db ? db.prepare('SELECT COUNT(*) AS n FROM kv').get().n : 0;
        if (stale) { db.exec('DELETE FROM kv'); console.warn(`${tag} 🧹 ${stale} keys from an earlier pairing had no credentials to go with them — removed`); }
        creds = initAuthCreds();
      }
      return { state: { creds, keys }, saveCreds: async () => { if (db) q.put.run('creds.json', JSON.stringify(creds, BufferJSON.replacer)); } };
    },
    /** WhatsApp accepted a connection made from this store: the set-aside folder is no longer a way back. */
    settle: async () => {
      if (!existsSync(setAside)) return;
      await rm(setAside, { recursive: true, force: true });
      console.log(`${tag} 🧹 old session folder removed`);
    },
    /** Logged out: nothing of the old session may be offered to WhatsApp again. */
    clear: async () => {
      if (db) db.exec('DELETE FROM kv');
      await rm(oldDir, { recursive: true, force: true });
      await rm(setAside, { recursive: true, force: true });
    },
    /**
     * Drop the sessions kept with these Signal users (`<user>` for a phone number, `<user>_1` for a
     * LID), every device of theirs: the next message to them opens a fresh one. Returns how many went.
     */
    forgetSessions: (users) => {
      if (!db) return 0;
      let n = 0;
      transaction(() => { for (const u of users) n += db.prepare("DELETE FROM kv WHERE k LIKE ? ESCAPE '\\'").run(`session-${String(u).replace(/[\\%_]/g, '\\$&')}.%`).changes; });
      return n;
    },
    close: () => { const d = db; db = null; try { d?.close(); } catch { /* already closed */ } },
  };
}
