// Thin wrapper around Obsidian's official headless client (`ob`).
//
// The `ob` binary is proprietary Obsidian software (npm package
// `obsidian-headless`, published UNLICENSED). This project does NOT bundle or
// redistribute it — the container installs it from npm at runtime (see
// docker-entrypoint.sh). Here we only shell out to whatever `ob` is on PATH.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { OB_HOME, VAULT_DIR, loadSettings } from "./config.js";
import { createRingBuffer } from "./ringbuffer.js";
import { notifyError } from "./notify.js";
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);
const OB_BIN = process.env.OB_BIN || "ob";

// `ob` reads/writes its login state from HOME. Point it at the persistent
// config volume so a container restart keeps the session.
const childEnv = { ...process.env, HOME: OB_HOME };

// The `ob` CLI (v0.0.x) prints human-readable text — there is no --json flag.
// We run the command and return its trimmed output as text; success is the exit
// code. Callers surface `text` to the UI and rely on `ok` for control flow.
async function run(args) {
  try {
    const { stdout, stderr } = await execFileAsync(OB_BIN, args, {
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, text: (stdout || stderr || "").trim() };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.stdout || err.message || "").trim() };
  }
}

export async function isInstalled() {
  try {
    await execFileAsync(OB_BIN, ["--version"], { env: childEnv });
    return true;
  } catch {
    return false;
  }
}

export function login({ email, password, mfa }) {
  const args = ["login", "--email", email, "--password", password];
  if (mfa) args.push("--mfa", mfa);
  return run(args);
}

export function logout() {
  return run(["logout"]);
}

// Parse `ob sync-list-remote` output. Each vault line looks like:
//   <id>  "<name>"  (<region>)
// Header/blank lines are ignored. Returns [] if nothing matches (caller then
// falls back to showing the raw text + manual entry).
export function parseVaultList(text) {
  const vaults = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+"([^"]*)"(?:\s*\(([^)]*)\))?\s*$/);
    if (m) vaults.push({ id: m[1], name: m[2], region: m[3] || "" });
  }
  return vaults;
}

export async function listRemote() {
  const res = await run(["sync-list-remote"]);
  if (!res.ok) return res;
  return { ok: true, text: res.text, vaults: parseVaultList(res.text) };
}

export function setup({ vault, encryption, password, deviceName }) {
  // End-to-end encryption is selected by providing the password; there is no
  // separate --encryption flag. Fail fast if E2E was chosen without a password,
  // so we never link a vault as "standard" while persisting "end-to-end".
  if (encryption === "end-to-end" && !password) {
    return Promise.resolve({ ok: false, error: "encryption-password-required" });
  }
  const args = ["sync-setup", "--vault", vault, "--path", VAULT_DIR];
  if (encryption === "end-to-end") args.push("--password", password);
  if (deviceName) args.push("--device-name", deviceName);
  return run(args);
}

export function status() {
  return run(["sync-status", "--path", VAULT_DIR]);
}

// --- Continuous sync supervision -------------------------------------------

let child = null;
let restartTimer = null;
let graceTimer = null;
let intervalTimer = null; // interval-mode scheduler
let oneShotRunning = false; // an interval-mode `ob sync` is in progress
let wantRunning = false;
let startedAt = 0;
let quickFailures = 0;
const STARTUP_GRACE_MS = 20000; // an exit within this window counts as a startup blip
const QUICK_FAIL_LIMIT = 3; // notify only if startup keeps failing this many times
const logBuffer = createRingBuffer(400);
const pushLog = (line) => logBuffer.push(line);

// Decide whether a sync exit warrants an error notification. A single transient
// exit right after start (common on boot) is suppressed; a crash after running a
// while, or repeated startup failures, notify. Pure so it can be unit-tested.
export function classifySyncExit(uptimeMs, priorQuickFailures) {
  if (uptimeMs >= STARTUP_GRACE_MS) return { notify: true, quickFailures: 0 };
  const next = priorQuickFailures + 1;
  return { notify: next >= QUICK_FAIL_LIMIT, quickFailures: next };
}

export function syncLogs() {
  return logBuffer.list();
}

// "Something is syncing right now" — includes a transient one-shot run. Used for
// UI status.
export function syncRunning() {
  return Boolean((child && child.exitCode === null) || intervalTimer || oneShotRunning);
}

// "A scheduler/child is active" — excludes a transient one-shot. Used to decide
// whether startSync should (re)arm; a lingering one-shot must not block a
// restart or a mode change.
function syncActive() {
  return Boolean((child && child.exitCode === null) || intervalTimer);
}

export function syncMode() {
  return loadSettings().sync?.mode === "interval" ? "interval" : "continuous";
}

export function startSync() {
  // Guard on syncActive (not syncRunning): a lingering one-shot from a previous
  // interval run must not block re-arming after a stop or a mode change.
  if (syncActive()) return { ok: true, alreadyRunning: true };
  wantRunning = true;
  if (syncMode() === "interval") return startInterval();
  return startContinuous();
}

// Interval mode: run a one-shot `ob sync` now and then every N minutes.
async function runOnce() {
  if (oneShotRunning) return;
  oneShotRunning = true;
  pushLog("[station] running one-shot sync");
  const res = await run(["sync", "--path", VAULT_DIR]);
  if (res.ok) pushLog(res.text || "[station] sync complete");
  else {
    pushLog("[station] sync failed: " + res.error);
    notifyError("Sync failed: " + res.error);
  }
  oneShotRunning = false;
}

function startInterval() {
  const minutes = Math.max(1, Number(loadSettings().sync?.intervalMinutes) || 5);
  pushLog(`[station] interval sync every ${minutes} min`);
  runOnce(); // run immediately, then on the interval
  intervalTimer = setInterval(runOnce, minutes * 60000);
  return { ok: true };
}

// Continuous mode: ob's own long-running watcher, supervised with restart.
function startContinuous() {
  startedAt = Date.now();
  child = spawn(OB_BIN, ["sync", "--path", VAULT_DIR, "--continuous"], {
    env: childEnv,
  });
  // Once a run stays healthy past the grace window, clear the startup-failure
  // counter so an unrelated blip much later isn't treated as a repeat failure.
  graceTimer = setTimeout(() => {
    quickFailures = 0;
  }, STARTUP_GRACE_MS);
  if (graceTimer.unref) graceTimer.unref();
  pushLog(`[station] continuous sync started (pid ${child.pid})`);
  child.stdout.on("data", (d) => pushLog(d.toString()));
  child.stderr.on("data", (d) => pushLog(d.toString()));
  child.on("exit", (code, signal) => {
    pushLog(`[station] sync exited (code=${code} signal=${signal})`);
    log.warn("sync exited", { code, signal });
    const uptime = Date.now() - startedAt;
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    child = null;
    // Supervised restart with a fixed backoff, unless a stop was requested.
    if (wantRunning) {
      const verdict = classifySyncExit(uptime, quickFailures);
      quickFailures = verdict.quickFailures;
      if (verdict.notify) {
        notifyError(`Continuous sync exited (code=${code} signal=${signal}, up ${Math.round(uptime / 1000)}s); restarting.`);
      }
      restartTimer = setTimeout(() => startSync(), 5000);
    }
  });
  return { ok: true };
}

export function stopSync() {
  wantRunning = false;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  // Resolve only once the continuous child has actually exited, so a caller that
  // restarts (e.g. a mode change) doesn't race a still-alive process and bail.
  // Bounded: SIGKILL after a grace period, and always resolve so a wedged child
  // can never hang /api/settings, restore, stop, or shutdown.
  if (child && child.exitCode === null) {
    const proc = child;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(failsafe);
        resolve({ ok: true });
      };
      const killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
      const failsafe = setTimeout(done, 8000);
      if (killTimer.unref) killTimer.unref();
      if (failsafe.unref) failsafe.unref();
      proc.once("exit", done);
      proc.kill("SIGTERM");
      pushLog("[station] stop requested");
    });
  }
  return Promise.resolve({ ok: true });
}
