#!/usr/bin/env node
// Obsidian Sync Station — web UI + API around the official headless Obsidian
// Sync client. LAN-only by design.

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

import {
  WEBUI_PORT,
  BACKUP_ENABLED,
  ensureDirs,
  loadSettings,
  saveSettings,
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
import { log } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

ensureDirs();

const app = Fastify({ logger: false, trustProxy: true });
await app.register(fastifyCookie, { secret: getCookieSecret() });
await app.register(fastifyStatic, {
  root: join(__dirname, "..", "public"),
  prefix: "/",
});

// Gate every /api route except the explicit public ones below.
const PUBLIC_ROUTES = new Set([
  "/api/health",
  "/api/state",
  "/api/setup-password",
  "/api/login",
]);

app.addHook("preHandler", async (request, reply) => {
  if (!request.url.startsWith("/api/")) return;
  const path = request.url.split("?")[0];
  if (PUBLIC_ROUTES.has(path)) return;
  if (!isAuthed(request, reply)) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

// --- Public endpoints -------------------------------------------------------

app.get("/api/health", async () => ({ status: "ok", version: pkg.version }));

app.get("/api/state", async (request, reply) => {
  const settings = loadSettings();
  const obInstalled = await ob.isInstalled();
  return {
    version: pkg.version,
    backupEnabled: BACKUP_ENABLED,
    setupNeeded: !settings.guiPasswordHash,
    authed: isAuthed(request, reply),
    obInstalled,
    deviceName: settings.deviceName,
    vaultLinked: settings.vaultLinked,
    vaultName: settings.vaultName,
    encryption: settings.encryption,
    syncRunning: ob.syncRunning(),
  };
});

app.post("/api/setup-password", async (request, reply) => {
  const settings = loadSettings();
  if (settings.guiPasswordHash) {
    return reply.code(409).send({ error: "already-configured" });
  }
  const { password } = request.body || {};
  if (!password || password.length < 8) {
    return reply.code(400).send({ error: "password-too-short" });
  }
  saveSettings({ guiPasswordHash: hashPassword(password) });
  createSession(reply);
  log.info("gui password set");
  return { ok: true };
});

app.post("/api/login", async (request, reply) => {
  const settings = loadSettings();
  const { password } = request.body || {};
  if (!verifyPassword(password || "", settings.guiPasswordHash)) {
    return reply.code(401).send({ error: "invalid-password" });
  }
  createSession(reply);
  return { ok: true };
});

// --- Authenticated endpoints ------------------------------------------------

app.post("/api/logout", async (request, reply) => {
  destroySession(request, reply);
  return { ok: true };
});

app.post("/api/obsidian/login", async (request) => {
  const { email, password, mfa } = request.body || {};
  if (!email || !password) return { ok: false, error: "email-and-password-required" };
  const result = await ob.login({ email, password, mfa });
  return result;
});

app.post("/api/obsidian/logout", async () => ob.logout());

app.get("/api/obsidian/vaults", async () => ob.listRemote());

app.post("/api/obsidian/setup", async (request) => {
  const { vault, encryption, password } = request.body || {};
  if (!vault) return { ok: false, error: "vault-required" };
  const result = await ob.setup({ vault, encryption, password, deviceName: loadSettings().deviceName });
  if (result.ok) {
    saveSettings({
      vaultLinked: true,
      vaultName: vault,
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

app.post("/api/sync/start", async () => ob.startSync());
app.post("/api/sync/stop", async () => ob.stopSync());
app.get("/api/sync/logs", async () => ({ logs: ob.syncLogs() }));

app.get("/api/settings", async () => {
  const s = loadSettings();
  return { deviceName: s.deviceName, autoStartSync: s.autoStartSync, notify: s.notify };
});

app.post("/api/settings", async (request) => {
  const { deviceName, autoStartSync, notify } = request.body || {};
  const patch = {};
  if (typeof deviceName === "string" && deviceName.trim()) patch.deviceName = deviceName.trim();
  if (typeof autoStartSync === "boolean") patch.autoStartSync = autoStartSync;
  if (notify && typeof notify === "object") {
    const n = {};
    if (typeof notify.url === "string") n.url = notify.url.trim();
    if (typeof notify.onBackup === "boolean") n.onBackup = notify.onBackup;
    if (typeof notify.onError === "boolean") n.onError = notify.onError;
    patch.notify = n;
  }
  const next = saveSettings(patch);
  return { ok: true, deviceName: next.deviceName, autoStartSync: next.autoStartSync, notify: next.notify };
});

// --- Backup (only meaningful when BACKUP=true) ------------------------------

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
  // Restoring over the live vault would otherwise be pushed to the remote by the
  // running sync — stop it first and leave it stopped for the user to review.
  ob.stopSync();
  const result = await backup.restoreToVault(name, confirm);
  return { ...result, syncStopped: true };
});

// --- Boot -------------------------------------------------------------------

async function boot() {
  const settings = loadSettings();
  if (settings.vaultLinked && settings.autoStartSync && (await ob.isInstalled())) {
    log.info("auto-starting continuous sync");
    ob.startSync();
  }
  if (BACKUP_ENABLED) backup.schedule();
}

try {
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
    ob.stopSync();
    backup.stop();
    await app.close();
    process.exit(0);
  });
}
