// Single source of truth for where persistent data lives.
// Locally it's <project>/data. In the cloud set DATA_DIR to a mounted volume
// (e.g. /data on Railway) so the WhatsApp session, DB and media survive redeploys.
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, readFileSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(__dirname, '..', 'data');

mkdirSync(dataDir, { recursive: true });

export const dataPath = (...parts) => join(dataDir, ...parts);

/**
 * Is DATA_DIR backed by a real mounted volume? In the cloud, DATA_DIR=/data is
 * expected to be a volume; if the volume is missing or detached, the app silently
 * writes to the container's ephemeral disk and the WhatsApp session dies on the
 * next restart — exactly the failure we want to make impossible to miss.
 *   null  → not applicable (DATA_DIR not set; local run)
 *   true  → DATA_DIR (or an ancestor other than /) is a mount point
 *   false → DATA_DIR is set but sits on the root filesystem
 */
export function dataDirIsMount() {
  if (!process.env.DATA_DIR) return null;
  try {
    // Linux: exact answer from the kernel's mount table.
    const mounts = readFileSync('/proc/mounts', 'utf8')
      .split('\n').map((l) => l.split(' ')[1]).filter(Boolean);
    let p = dataDir;
    while (p && p !== '/') {
      if (mounts.includes(p)) return true;
      p = dirname(p);
    }
    return false;
  } catch {
    // Non-Linux fallback: a different device id than the parent means a mount.
    try { return statSync(dataDir).dev !== statSync(dirname(dataDir)).dev; } catch { return false; }
  }
}
