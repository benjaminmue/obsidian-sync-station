// Local vault backups (Milestone 2).
//
// When BACKUP=true, the station takes scheduled tar.gz snapshots of the vault
// into the mapped backup volume (/backup -> Unraid storage) and prunes old ones
// by a retention count. Run-now and a snapshot listing are exposed in the UI.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync, unlinkSync, existsSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import cron from "node-cron";

import {
  BACKUP_ENABLED,
  BACKUP_DIR,
  VAULT_DIR,
  MIRROR_ENABLED,
  MIRROR_DIR,
  RESTORE_DIR,
  loadSettings,
  saveSettings,
} from "./config.js";
import { createRingBuffer } from "./ringbuffer.js";
import { notifyBackup, notifyError } from "./notify.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);
const PREFIX = "vault-";
const SUFFIX = ".tar.gz";

let task = null; // active cron task
let running = false; // a snapshot is in progress
let lastRun = null; // { ts, ok, error }
const logBuffer = createRingBuffer(200);
const pushLog = (line) => logBuffer.push(line);

function stamp() {
  // vault-YYYYMMDD-HHMMSS-mmm (local time per container TZ). Millisecond suffix
  // keeps names ordered and avoids collisions between quick successive runs.
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

function uniqueTarget() {
  const base = `${PREFIX}${stamp()}`;
  let name = `${base}${SUFFIX}`;
  let i = 1;
  while (existsSync(join(BACKUP_DIR, name))) name = `${base}-${i++}${SUFFIX}`;
  return name;
}

function snapshotsIn(dir) {
  let files = [];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function listSnapshots() {
  return snapshotsIn(BACKUP_DIR);
}

function pruneDir(dir, retention) {
  const keep = Math.max(1, Number(retention) || 1);
  const toDelete = snapshotsIn(dir).slice(keep); // newest first, drop the tail
  for (const s of toDelete) {
    try {
      unlinkSync(join(dir, s.name));
      pushLog(`pruned old snapshot ${s.name} in ${dir}`);
    } catch (err) {
      pushLog(`prune failed for ${s.name}: ${err.message}`);
    }
  }
  return toDelete.length;
}

// Copy a freshly created snapshot to the optional mirror destination and prune
// the mirror by the same retention. Best-effort: a mirror failure is logged but
// does not fail the primary backup.
function mirror(name, retention) {
  if (!MIRROR_ENABLED) return;
  try {
    copyFileSync(join(BACKUP_DIR, name), join(MIRROR_DIR, name));
    const pruned = pruneDir(MIRROR_DIR, retention);
    pushLog(`mirrored ${name} -> ${MIRROR_DIR} (pruned ${pruned})`);
  } catch (err) {
    pushLog(`mirror failed for ${name}: ${err.message}`);
    log.warn("mirror failed", { name, error: err.message });
  }
}

export async function runBackup() {
  if (!BACKUP_ENABLED) return { ok: false, error: "backup-disabled" };
  if (running) return { ok: false, error: "already-running" };
  running = true;
  const name = uniqueTarget();
  const target = join(BACKUP_DIR, name);
  pushLog(`starting snapshot ${name}`);
  try {
    // Archive vault contents (not the top dir) so restores are clean.
    await execFileAsync("tar", ["-czf", target, "-C", VAULT_DIR, "."], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const size = statSync(target).size;
    const retention = loadSettings().backup.retention;
    const pruned = pruneDir(BACKUP_DIR, retention);
    mirror(name, retention);
    lastRun = { ts: new Date().toISOString(), ok: true };
    pushLog(`snapshot done: ${name} (${size} bytes), pruned ${pruned}`);
    log.info("backup done", { name, size, pruned });
    notifyBackup(`Snapshot ${name} created (${size} bytes).`);
    return { ok: true, name, size, pruned };
  } catch (err) {
    // Remove any partially written archive so a failed run never surfaces as a
    // valid snapshot in the listing or gets counted by retention pruning.
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      /* best effort */
    }
    lastRun = { ts: new Date().toISOString(), ok: false, error: err.message };
    pushLog(`snapshot failed: ${err.message}`);
    log.error("backup failed", { error: err.message });
    notifyError(`Backup failed: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

export function schedule() {
  if (!BACKUP_ENABLED) return;
  if (task) {
    task.stop();
    task = null;
  }
  const { schedule: expr } = loadSettings().backup;
  if (!cron.validate(expr)) {
    log.error("invalid backup cron, backups not scheduled", { expr });
    pushLog(`invalid cron expression: ${expr}`);
    return;
  }
  task = cron.schedule(expr, () => {
    runBackup();
  });
  log.info("backup scheduled", { expr });
  pushLog(`scheduled: ${expr}`);
}

export function configure({ schedule: expr, retention }) {
  const patch = {};
  if (typeof expr === "string" && expr.trim()) {
    if (!cron.validate(expr.trim())) return { ok: false, error: "invalid-cron" };
    patch.schedule = expr.trim();
  }
  if (retention !== undefined) {
    const r = Number(retention);
    if (!Number.isInteger(r) || r < 1 || r > 365) return { ok: false, error: "invalid-retention" };
    patch.retention = r;
  }
  saveSettings({ backup: patch });
  schedule(); // re-arm with new expression
  const s = loadSettings().backup;
  return { ok: true, schedule: s.schedule, retention: s.retention };
}

// A name is only accepted if it matches an existing snapshot exactly — this also
// guards against path traversal via the name parameter.
function validName(name) {
  return listSnapshots().some((s) => s.name === name);
}

export function hasSnapshot(name) {
  return validName(name);
}

// Extract a snapshot into a per-snapshot staging folder under /config/restores.
// Safe: never touches the live vault, so nothing is pushed to the remote.
export async function restoreToStaging(name) {
  if (!validName(name)) return { ok: false, error: "unknown-snapshot" };
  const dest = join(RESTORE_DIR, name.replace(/\.tar\.gz$/, ""));
  try {
    mkdirSync(dest, { recursive: true });
    await execFileAsync("tar", ["-xzf", join(BACKUP_DIR, name), "-C", dest], {
      maxBuffer: 10 * 1024 * 1024,
    });
    pushLog(`restored ${name} to staging ${dest}`);
    return { ok: true, path: dest };
  } catch (err) {
    pushLog(`restore-to-staging failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Extract a snapshot directly over the live vault. DESTRUCTIVE: once sync
// resumes, the restored state is pushed to the remote. Requires confirm=true;
// the caller must stop continuous sync first.
export async function restoreToVault(name, confirm) {
  if (confirm !== true) return { ok: false, error: "confirm-required" };
  if (!validName(name)) return { ok: false, error: "unknown-snapshot" };
  try {
    // Replace, not merge: clear the vault first so the result is the exact
    // snapshot state. Otherwise files created/renamed after the snapshot would
    // survive and get pushed back to the remote once sync resumes.
    for (const entry of readdirSync(VAULT_DIR)) {
      rmSync(join(VAULT_DIR, entry), { recursive: true, force: true });
    }
    await execFileAsync("tar", ["-xzf", join(BACKUP_DIR, name), "-C", VAULT_DIR], {
      maxBuffer: 10 * 1024 * 1024,
    });
    pushLog(`restored ${name} into vault`);
    log.warn("vault restored from snapshot", { name });
    return { ok: true };
  } catch (err) {
    pushLog(`restore-to-vault failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export function stop() {
  if (task) {
    task.stop();
    task = null;
  }
}

export function status() {
  const s = loadSettings().backup;
  return {
    enabled: BACKUP_ENABLED,
    schedule: s.schedule,
    retention: s.retention,
    running,
    lastRun,
    count: listSnapshots().length,
    dir: BACKUP_DIR,
    mirror: { enabled: MIRROR_ENABLED, dir: MIRROR_DIR, count: snapshotsIn(MIRROR_DIR).length },
  };
}

export function logs() {
  return logBuffer.list();
}
