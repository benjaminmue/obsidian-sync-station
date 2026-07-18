// Thin wrapper around Obsidian's official headless client (`ob`).
//
// The `ob` binary is proprietary Obsidian software (npm package
// `obsidian-headless`, published UNLICENSED). This project does NOT bundle or
// redistribute it — the container installs it from npm at runtime (see
// docker-entrypoint.sh). Here we only shell out to whatever `ob` is on PATH.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { OB_HOME, VAULT_DIR } from "./config.js";
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

export function listRemote() {
  return run(["sync-list-remote"]);
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

export function syncRunning() {
  return Boolean(child && child.exitCode === null);
}

export function startSync() {
  if (syncRunning()) return { ok: true, alreadyRunning: true };
  wantRunning = true;
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
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    pushLog("[station] stop requested");
  }
  return { ok: true };
}
