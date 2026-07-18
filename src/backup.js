// Local vault backups (Milestone 2).
//
// When BACKUP=true, the station takes scheduled tar.gz snapshots of the vault
// into the mapped backup volume (/backup -> Unraid storage) and prunes old ones
// by a retention count. Run-now and a snapshot listing are exposed in the UI.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import cron from "node-cron";

import { BACKUP_ENABLED, BACKUP_DIR, VAULT_DIR, loadSettings, saveSettings } from "./config.js";
import { createRingBuffer } from "./ringbuffer.js";
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

export function listSnapshots() {
  let files = [];
  try {
    files = readdirSync(BACKUP_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .map((f) => {
      const st = statSync(join(BACKUP_DIR, f));
      return { name: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function prune(retention) {
  const keep = Math.max(1, Number(retention) || 1);
  const snaps = listSnapshots(); // newest first
  const toDelete = snaps.slice(keep);
  for (const s of toDelete) {
    try {
      unlinkSync(join(BACKUP_DIR, s.name));
      pushLog(`pruned old snapshot ${s.name}`);
    } catch (err) {
      pushLog(`prune failed for ${s.name}: ${err.message}`);
    }
  }
  return toDelete.length;
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
    const pruned = prune(loadSettings().backup.retention);
    lastRun = { ts: new Date().toISOString(), ok: true };
    pushLog(`snapshot done: ${name} (${size} bytes), pruned ${pruned}`);
    log.info("backup done", { name, size, pruned });
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
  };
}

export function logs() {
  return logBuffer.list();
}
