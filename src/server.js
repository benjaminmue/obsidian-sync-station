#!/usr/bin/env node
// Obsidian Sync Station: web UI + API around the official headless Obsidian
// Sync client. LAN-only by design.

import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";

import {
  WEBUI_PORT,
  BACKUP_ENABLED,
  ensureDirs,
  loadSettings,
  saveSettings,
  settingsUnreadable,
} from "./config.js";
import {
  hashPassword,
  verifyPassword,
  getCookieSecret,
  createSession,
  destroySession,
  isAuthed,
} from "./auth.js";
import * as ob from "./ob.js";
import * as backup from "./backup.js";
import * as restic from "./restic.js";
import { log } from "./logger.js";
import { registerWebUi } from "./webui.js";
import { registerRequestGuards, createLoginLimiter } from "./guards.js";
import { withLock, RESTORE_VAULT } from "./lock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

// Every /api route needs a session except these. See guards.js.
const PUBLIC_ROUTES = new Set([
  "/api/health",
  "/api/state",
  "/api/setup-password",
  "/api/login",
]);

// Upper bound for any credential or name taken from a request body. Generous
// for real input, small enough that scrypt and the ob CLI never see megabytes.
const MAX_FIELD_LENGTH = 1024;

// A non-empty string of sane length.
function validField(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

// Absent, or a valid field.
function optionalField(value) {
  return value === undefined || value === null || value === "" || validField(value);
}

const SETTINGS_UNREADABLE = { error: "settings-unreadable" };

// Builds the app with every route registered, without listening or starting
// anything in the background, so tests can run against the real route table.
// `onRoute` lets a caller observe each route as it is registered.
export async function buildApp({ onRoute } = {}) {
  const app = Fastify({ logger: false, trustProxy: true });
  if (onRoute) app.addHook("onRoute", onRoute);

  // Tolerate body-less POSTs that still send `Content-Type: application/json`
  // (fetch does this): an empty body parses to {} instead of a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || !body.trim()) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  });

  await app.register(fastifyCookie, { secret: getCookieSecret() });
  await registerWebUi(app, { root: join(__dirname, "..", "public"), version: pkg.version });

  registerRequestGuards(app, { publicRoutes: PUBLIC_ROUTES, isAuthed });
  const loginLimiter = createLoginLimiter();

  // --- Public endpoints ------------------------------------------------------

  app.get("/api/health", async () => ({ status: "ok", version: pkg.version }));

  app.get("/api/state", async (request, reply) => {
    const settings = loadSettings();
    const settingsError = settingsUnreadable();
    const authed = isAuthed(request, reply);
    const obInstalled = await ob.isInstalled();
    // Anonymous callers get only what the setup and sign-in screens need; vault,
    // device and sync details are for signed-in users.
    const publicState = {
      version: pkg.version,
      setupNeeded: !settingsError && !settings.guiPasswordHash,
      authed,
      obInstalled,
      settingsError,
    };
    if (!authed) return publicState;
    return {
      ...publicState,
      backupEnabled: BACKUP_ENABLED,
      resticEnabled: restic.enabled(),
      deviceName: settings.deviceName,
      vaultLinked: settings.vaultLinked,
      vaultName: settings.vaultName,
      encryption: settings.encryption,
      syncRunning: ob.syncRunning(),
      syncBusy: ob.syncBusy(),
      syncNextRunAt: ob.syncNextRunAt(),
      syncMode: settings.sync.mode,
      syncIntervalMinutes: settings.sync.intervalMinutes,
    };
  });

  app.post("/api/setup-password", async (request, reply) => {
    // Unreadable settings look like a first run (no password hash). Refuse, or
    // anyone on the network could claim the station.
    if (settingsUnreadable()) return reply.code(503).send(SETTINGS_UNREADABLE);
    const settings = loadSettings();
    if (settings.guiPasswordHash) {
      return reply.code(409).send({ error: "already-configured" });
    }
    const { password } = request.body || {};
    if (typeof password !== "string" || password.length < 8) {
      return reply.code(400).send({ error: "password-too-short" });
    }
    if (password.length > MAX_FIELD_LENGTH) return reply.code(400).send({ error: "password-too-long" });
    saveSettings({ guiPasswordHash: hashPassword(password) });
    createSession(request, reply);
    log.info("gui password set");
    return { ok: true };
  });

  app.post("/api/login", async (request, reply) => {
    if (settingsUnreadable()) return reply.code(503).send(SETTINGS_UNREADABLE);
    const settings = loadSettings();
    if (loginLimiter.blocked()) {
      reply.header("Retry-After", String(loginLimiter.retryAfterSeconds()));
      return reply.code(429).send({ error: "too-many-attempts" });
    }
    const { password } = request.body || {};
    // A malformed password is a failed attempt like any other, decided before
    // scrypt runs.
    if (!validField(password) || !verifyPassword(password, settings.guiPasswordHash)) {
      loginLimiter.fail();
      return reply.code(401).send({ error: "invalid-password" });
    }
    createSession(request, reply);
    return { ok: true };
  });

  // --- Authenticated endpoints -----------------------------------------------

  app.post("/api/logout", async (request, reply) => {
    destroySession(request, reply);
    return { ok: true };
  });

  app.post("/api/obsidian/login", async (request, reply) => {
    const { email, password, mfa } = request.body || {};
    if (!email || !password) return { ok: false, error: "email-and-password-required" };
    if (!validField(email) || !validField(password) || !optionalField(mfa)) {
      return reply.code(400).send({ ok: false, error: "invalid-input" });
    }
    return ob.login({ email, password, mfa });
  });

  app.post("/api/obsidian/logout", async () => ob.logout());

  app.get("/api/obsidian/vaults", async () => ob.listRemote());

  app.post("/api/obsidian/setup", async (request, reply) => {
    const { vault, vaultName, encryption, password } = request.body || {};
    if (!vault) return { ok: false, error: "vault-required" };
    if (!validField(vault) || !optionalField(vaultName) || !optionalField(password)) {
      return reply.code(400).send({ ok: false, error: "invalid-input" });
    }
    const result = await ob.setup({ vault, encryption, password, deviceName: loadSettings().deviceName });
    if (result.ok) {
      saveSettings({
        vaultLinked: true,
        vaultId: vault, // the id/name we linked with
        vaultName: vaultName || vault, // display name if known, else the id/name entered
        encryption: encryption === "end-to-end" ? "end-to-end" : "standard",
      });
      if (loadSettings().autoStartSync) ob.startSync();
    }
    return result;
  });

  app.get("/api/sync/status", async () => {
    const status = await ob.status();
    return { ...status, running: ob.syncRunning() };
  });

  app.get("/api/sync/badge", async () => ({
    running: ob.syncRunning(),
    busy: ob.syncBusy(),
    nextRunAt: ob.syncNextRunAt(),
    mode: loadSettings().sync.mode,
    // Rides along with the badge poll so the UI can warn without another request.
    // Authenticated route: vault paths never reach an anonymous caller.
    permissionIssue: ob.syncPermissionIssue(),
  }));

  app.post("/api/sync/start", async () => ob.startSync());
  app.post("/api/sync/stop", async () => ob.stopSync());
  app.get("/api/sync/logs", async () => ({ logs: ob.syncLogs() }));

  // Never expose the ntfy token to the browser; report only whether one is set.
  function publicNotify(n) {
    return { url: n.url, onBackup: n.onBackup, onError: n.onError, tokenSet: Boolean(n.token) };
  }

  app.get("/api/settings", async () => {
    const s = loadSettings();
    return { deviceName: s.deviceName, autoStartSync: s.autoStartSync, notify: publicNotify(s.notify), sync: s.sync };
  });

  app.post("/api/settings", async (request) => {
    const { deviceName, autoStartSync, notify, sync } = request.body || {};
    const patch = {};
    if (validField(deviceName) && deviceName.trim()) patch.deviceName = deviceName.trim();
    if (typeof autoStartSync === "boolean") patch.autoStartSync = autoStartSync;
    if (notify && typeof notify === "object") {
      const n = {};
      if (typeof notify.url === "string") n.url = notify.url.trim();
      if (typeof notify.onBackup === "boolean") n.onBackup = notify.onBackup;
      if (typeof notify.onError === "boolean") n.onError = notify.onError;
      // Token behaves like a password field: empty = leave unchanged, a non-empty
      // value overwrites, and an explicit clearToken flag removes it (back to a
      // public topic).
      if (notify.clearToken === true) n.token = "";
      else if (typeof notify.token === "string" && notify.token.trim()) n.token = notify.token.trim();
      patch.notify = n;
    }
    let syncChanged = false;
    if (sync && typeof sync === "object") {
      const cur = loadSettings().sync;
      const sc = {};
      if (sync.mode === "continuous" || sync.mode === "interval") sc.mode = sync.mode;
      if (sync.intervalMinutes !== undefined) {
        const m = Number(sync.intervalMinutes);
        if (!Number.isInteger(m) || m < 1 || m > 1440) return { ok: false, error: "invalid-interval" };
        sc.intervalMinutes = m;
      }
      patch.sync = sc;
      syncChanged = (sc.mode && sc.mode !== cur.mode) || (sc.intervalMinutes && sc.intervalMinutes !== cur.intervalMinutes);
    }
    // Capture BEFORE saving: only re-apply if sync was actually running, so we
    // never turn sync back on when the user intentionally stopped it.
    const wasRunning = ob.syncRunning();
    const next = saveSettings(patch);
    if (syncChanged && wasRunning && next.vaultLinked && (await ob.isInstalled())) {
      await ob.stopSync(); // wait for the running child to actually exit before re-arming
      ob.startSync();
    }
    return { ok: true, deviceName: next.deviceName, autoStartSync: next.autoStartSync, notify: publicNotify(next.notify), sync: next.sync };
  });

  // --- Backup (only meaningful when BACKUP=true) -----------------------------

  app.get("/api/backup/status", async () => backup.status());
  app.get("/api/backup/list", async () => ({ snapshots: backup.listSnapshots() }));
  app.get("/api/backup/logs", async () => ({ logs: backup.logs() }));
  app.post("/api/backup/run", async () => backup.runBackup());
  app.post("/api/backup/config", async (request) => {
    const { schedule, retention } = request.body || {};
    return backup.configure({ schedule, retention });
  });

  app.post("/api/backup/restore-staging", async (request) => {
    const { name } = request.body || {};
    if (!name) return { ok: false, error: "name-required" };
    return backup.restoreToStaging(name);
  });

  app.post("/api/backup/restore-vault", async (request) => {
    const { name, confirm } = request.body || {};
    if (!name) return { ok: false, error: "name-required" };
    // Validate BEFORE touching sync, so a rejected request never leaves sync off.
    if (confirm !== true) return { ok: false, error: "confirm-required" };
    if (!backup.hasSnapshot(name)) return { ok: false, error: "unknown-snapshot" };
    // The lock keeps backups and restic restores out, and sync from being
    // started again, until the vault is fully restored.
    return withLock(RESTORE_VAULT, async () => {
      // Restoring over the live vault would otherwise be pushed to the remote by
      // a running sync, so stop it (and wait for it to exit) before overwriting.
      await ob.stopSync();
      const result = await backup.restoreToVault(name, confirm);
      return { ...result, syncStopped: true };
    });
  });

  // --- Off-site backup (restic) ----------------------------------------------

  app.get("/api/restic/status", async () => restic.status());
  app.get("/api/restic/snapshots", async () => ({ snapshots: await restic.snapshots() }));
  app.get("/api/restic/logs", async () => ({ logs: restic.logs() }));
  // Locked here rather than in restic.backup(): runBackup() calls that too, and
  // already holds the lock.
  app.post("/api/restic/run", async () => withLock("restic-backup", restic.backup));
  app.post("/api/restic/restore", async (request) => {
    const { id } = request.body || {};
    if (!id) return { ok: false, error: "id-required" };
    return restic.restore(id);
  });

  return app;
}

// --- Boot -------------------------------------------------------------------

// Resolve the linked vault's friendly display name from sync-list-remote once at
// boot, so vaults linked before names were stored (or entered by id) show the
// real name instead of the raw id.
async function resolveVaultName() {
  const s = loadSettings();
  if (!s.vaultLinked) return;
  const target = s.vaultId || s.vaultName;
  try {
    const res = await ob.listRemote();
    const match = (res.vaults || []).find((v) => v.id === target || v.name === target);
    if (match && (s.vaultName !== match.name || s.vaultId !== match.id)) {
      saveSettings({ vaultName: match.name, vaultId: match.id });
      log.info("resolved vault display name", { name: match.name });
    }
  } catch {
    /* best effort; keep whatever is stored */
  }
}

async function boot() {
  // Fail closed: with unreadable settings the vault link, sync mode and
  // backup retention are unknown, and defaults could prune good snapshots.
  if (settingsUnreadable()) return;
  const settings = loadSettings();
  if (settings.vaultLinked && (await ob.isInstalled())) {
    await resolveVaultName();
    if (settings.autoStartSync) {
      log.info("auto-starting sync");
      ob.startSync();
    }
  }
  if (BACKUP_ENABLED) backup.schedule();
}

async function main() {
  ensureDirs();
  let app;
  try {
    app = await buildApp();
    await app.listen({ host: "0.0.0.0", port: WEBUI_PORT });
    log.info("obsidian-sync-station listening", { port: WEBUI_PORT, version: pkg.version });
    await boot();
  } catch (err) {
    log.error("failed to start", { error: err.message });
    process.exit(1);
  }

  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      log.info("shutting down", { signal: sig });
      await ob.stopSync();
      backup.stop();
      await app.close();
      process.exit(0);
    });
  }
}

// Start only when run directly (`node src/server.js`, or the npm bin link),
// not when a test imports buildApp.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
