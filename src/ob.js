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
import { log } from "./logger.js";

const execFileAsync = promisify(execFile);
const OB_BIN = process.env.OB_BIN || "ob";

// `ob` reads/writes its login state from HOME. Point it at the persistent
// config volume so a container restart keeps the session.
const childEnv = { ...process.env, HOME: OB_HOME };

export function parseJson(stdout) {
  const text = (stdout || "").trim();
  if (!text) return null;
  // Be defensive: the CLI may print a banner line before the JSON payload.
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const startArr = text.indexOf("[");
    const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
    if (from >= 0) {
      try {
        return JSON.parse(text.slice(from));
      } catch {
        /* fall through */
      }
    }
    return { raw: text };
  }
}

async function run(args) {
  try {
    const { stdout } = await execFileAsync(OB_BIN, [...args, "--json"], {
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, data: parseJson(stdout) };
  } catch (err) {
    const detail = parseJson(err.stdout) || parseJson(err.stderr) || err.message;
    return { ok: false, error: detail };
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

export function setup({ vault, encryption, password }) {
  const args = ["sync-setup", "--vault", vault, "--path", VAULT_DIR];
  if (encryption === "end-to-end") {
    args.push("--encryption", "end-to-end");
    if (password) args.push("--password", password);
  }
  return run(args);
}

export function status() {
  return run(["sync-status"]);
}

// --- Continuous sync supervision -------------------------------------------

let child = null;
let restartTimer = null;
let wantRunning = false;
const logBuffer = createRingBuffer(400);
const pushLog = (line) => logBuffer.push(line);

export function syncLogs() {
  return logBuffer.list();
}

export function syncRunning() {
  return Boolean(child && child.exitCode === null);
}

export function startSync() {
  if (syncRunning()) return { ok: true, alreadyRunning: true };
  wantRunning = true;
  child = spawn(OB_BIN, ["sync", "--path", VAULT_DIR, "--continuous"], {
    env: childEnv,
  });
  pushLog(`[station] continuous sync started (pid ${child.pid})`);
  child.stdout.on("data", (d) => pushLog(d.toString()));
  child.stderr.on("data", (d) => pushLog(d.toString()));
  child.on("exit", (code, signal) => {
    pushLog(`[station] sync exited (code=${code} signal=${signal})`);
    log.warn("sync exited", { code, signal });
    child = null;
    // Supervised restart with a fixed backoff, unless a stop was requested.
    if (wantRunning) {
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
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    pushLog("[station] stop requested");
  }
  return { ok: true };
}
