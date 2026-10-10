/**
 * Names and terms the models should recognise for ONE account — family names,
 * products, places — so a transcript's "התכון" becomes "עדכון" and a phonetic
 * "by far" is not turned into a child called יפר. Managed from WhatsApp
 * ("names: דוד, עדן" in Notes to self) and merged at prompt time with the
 * contact names the agent has seen. Stored as a JSON file in the account's dir.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MAX = 200;

export function createGlossary(file, seed = []) {
  let names;
  try { names = new Set(JSON.parse(readFileSync(file, 'utf8'))); }
  catch { names = new Set(seed.map((s) => String(s).trim()).filter(Boolean)); if (names.size) save(); }

  function save() { try { writeFileSync(file, JSON.stringify([...names], null, 2)); } catch (e) { console.warn('glossary save failed:', e.message); } }

  return {
    list() { return [...names]; },
    add(list) {
      let added = 0;
      for (const raw of list) {
        const n = String(raw || '').trim().replace(/^["'«]+|["'»]+$/g, '');
        if (!n || n.length > 40 || names.has(n)) continue;
        names.add(n); added++;
      }
      while (names.size > MAX) names.delete(names.values().next().value);
      if (added) save();
      return added;
    },
    remove(list) {
      let removed = 0;
      for (const raw of list) if (names.delete(String(raw || '').trim())) removed++;
      if (removed) save();
      return removed;
    },
    /** One comma-separated line for a prompt: glossary first, then extra names, deduped, capped. */
    hint(extra = [], cap = 80) {
      const seen = new Set(); const out = [];
      for (const n of [...names, ...extra]) {
        const v = String(n || '').trim();
        if (!v || seen.has(v)) continue;
        seen.add(v); out.push(v);
        if (out.length >= cap) break;
      }
      return out.join(', ');
    },
  };
}
