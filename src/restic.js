// Optional off-site backups via restic (Milestone 5).
//
// restic backs up the vault to an encrypted repository. The repository URL and
// password (and any cloud credentials) are provided ONLY via environment
// variables so secrets never land in settings.json:
//   RESTIC_REPOSITORY  e.g. /backup/restic, s3:s3.amazonaws.com/bucket,
//                      b2:bucket:path, sftp:user@host:/path
//   RESTIC_PASSWORD    repository encryption password
//   + backend creds (AWS_ACCESS_KEY_ID, B2_ACCOUNT_ID, ...) inherited as-is.
//
// restic runs alongside local snapshots (see backup.js): it backs up /vault
// directly, and its repo is encrypted regardless of the vault's own encryption.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { VAULT_DIR, RESTORE_DIR, CONFIG_DIR, loadSettings } from "./config.js";
import { createRingBuffer } from "./ringbuffer.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);
const RESTIC_BIN = process.env.RESTIC_BIN || "restic";
const RESTIC_REPO = process.env.RESTIC_REPOSITORY || "";
const RESTIC_ENABLED = Boolean(RESTIC_REPO);
const TAG = "obsidian-sync-station";
// Keep restic's cache on the persistent config volume, not the container's
// ephemeral root home.
const CHILD_ENV = { ...process.env, RESTIC_CACHE_DIR: process.env.RESTIC_CACHE_DIR || join(CONFIG_DIR, "restic-cache") };

let running = false;
let lastRun = null;
const logBuffer = createRingBuffer(200);

export function enabled() {
  return RESTIC_ENABLED;
}

async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(RESTIC_BIN, args, {
      env: CHILD_ENV, // carries RESTIC_REPOSITORY/RESTIC_PASSWORD + cloud creds
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, text: (stdout || stderr || "").trim(), code: 0 };
  } catch (err) {
    return {
      ok: false,
      error: (err.stderr || err.stdout || err.message || "").trim(),
      code: typeof err.code === "number" ? err.code : 1,
    };
  }
}

export async function available() {
  try {
    await execFileAsync(RESTIC_BIN, ["version"], { env: CHILD_ENV });
    return true;
  } catch {
    return false;
  }
}

// Initialize the repo on first use; a successful `cat config` means it exists.
async function ensureRepo() {
  const check = await run(["cat", "config"]);
  if (check.ok) return { ok: true };
  logBuffer.push("initializing restic repository");
  return run(["init"]);
}

export async function backup() {
  if (!RESTIC_ENABLED) return { ok: false, error: "restic-disabled" };
  if (running) return { ok: false, error: "already-running" };
  running = true;
  logBuffer.push("starting restic backup");
  try {
    const ready = await ensureRepo();
    if (!ready.ok) throw new Error("repo init failed: " + ready.error);
    const device = loadSettings().deviceName;
    const res = await run(["backup", VAULT_DIR, "--tag", TAG, "--host", device]);
    // restic exit code 3 = snapshot created but some files could not be read
    // (common when the live-synced vault has a file mid-write). Treat as a
    // warning, not a hard failure — the snapshot still exists.
    if (!res.ok && res.code === 3) {
      logBuffer.push("restic backup completed with warnings (some files were unreadable)");
    } else if (!res.ok) {
      throw new Error(res.error);
    }
    const keep = Math.max(1, Number(loadSettings().backup.retention) || 1);
    const forget = await run(["forget", "--keep-last", String(keep), "--prune", "--tag", TAG]);
    if (!forget.ok) throw new Error("backup ok but forget/prune failed: " + forget.error);
    lastRun = { ts: new Date().toISOString(), ok: true };
    logBuffer.push("restic backup done");
    log.info("restic backup done");
    return { ok: true };
  } catch (err) {
    lastRun = { ts: new Date().toISOString(), ok: false, error: err.message };
    logBuffer.push("restic backup failed: " + err.message);
    log.error("restic backup failed", { error: err.message });
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

export async function snapshots() {
  if (!RESTIC_ENABLED) return [];
  const res = await run(["snapshots", "--json", "--tag", TAG]);
  if (!res.ok) return [];
  try {
    const arr = JSON.parse(res.text);
    return arr.map((s) => ({ id: s.short_id || s.id, time: s.time, host: s.hostname }));
  } catch {
    return [];
  }
}

export async function restore(id) {
  if (!RESTIC_ENABLED) return { ok: false, error: "restic-disabled" };
  // Only accept an id restic actually knows (guards the argument).
  const snaps = await snapshots();
  if (!snaps.some((s) => s.id === id)) return { ok: false, error: "unknown-snapshot" };
  const dest = join(RESTORE_DIR, "restic-" + id);
  try {
    mkdirSync(dest, { recursive: true });
    const res = await run(["restore", id, "--target", dest]);
    if (!res.ok) throw new Error(res.error);
    logBuffer.push(`restored restic snapshot ${id} to ${dest}`);
    return { ok: true, path: dest };
  } catch (err) {
    logBuffer.push(`restic restore failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export function status() {
  return { enabled: RESTIC_ENABLED, repo: RESTIC_REPO, running, lastRun };
}

export function logs() {
  return logBuffer.list();
}
