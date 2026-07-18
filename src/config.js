// Persistent configuration and paths.
//
// Everything the station remembers lives under CONFIG_DIR (mapped to the Unraid
// appdata volume in production). The official `ob` client keeps its own login
// state in HOME, so we point HOME at CONFIG_DIR/ob-home for the child processes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
export const VAULT_DIR = process.env.VAULT_DIR || "/vault";
export const BACKUP_DIR = process.env.BACKUP_DIR || "/backup";
export const OB_HOME = join(CONFIG_DIR, "ob-home");
export const RESTORE_DIR = join(CONFIG_DIR, "restores");

export const BACKUP_ENABLED = String(process.env.BACKUP || "false").toLowerCase() === "true";
export const MIRROR_ENABLED = String(process.env.MIRROR || "false").toLowerCase() === "true";
export const MIRROR_DIR = process.env.MIRROR_DIR || "/mirror";
export const WEBUI_PORT = Number(process.env.WEBUI_PORT || 8080);

const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

// Nested settings objects that get a deep (one level) merge with defaults.
const NESTED_KEYS = ["backup", "notify", "sync"];

const DEFAULTS = {
  guiPasswordHash: null, // scrypt hash; null = first-run setup needed
  cookieSecret: null, // generated once
  deviceName: process.env.DEVICE_NAME || "obsidian-sync-station",
  vaultLinked: false,
  vaultName: null,
  vaultId: null, // the id/name passed to sync-setup; used to resolve the display name
  encryption: "standard", // "standard" | "end-to-end"
  autoStartSync: true, // start sync on boot once linked
  sync: {
    mode: "continuous", // "continuous" (ob --continuous) | "interval" (one-shot every N min)
    intervalMinutes: 5,
  },
  backup: {
    schedule: "0 3 * * *", // daily 03:00
    retention: 7,
  },
  notify: {
    url: process.env.NTFY_URL || "", // ntfy topic URL, e.g. https://ntfy.example.com/obsidian
    token: process.env.NTFY_TOKEN || "", // optional ntfy access token (Bearer) for protected servers
    onBackup: true, // notify on successful backup
    onError: true, // notify on backup/sync failure
  },
};

let cache = null;

export function ensureDirs() {
  for (const dir of [CONFIG_DIR, OB_HOME, VAULT_DIR, RESTORE_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  if (BACKUP_ENABLED && !existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  if (MIRROR_ENABLED && !existsSync(MIRROR_DIR)) mkdirSync(MIRROR_DIR, { recursive: true });
}

export function loadSettings() {
  if (cache) return cache;
  let stored = {};
  if (existsSync(SETTINGS_FILE)) {
    try {
      stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    } catch {
      // Corrupt settings should not brick the station; fall back to defaults
      // and let the user reconfigure through the UI.
      stored = {};
    }
  }
  cache = { ...DEFAULTS, ...stored };
  for (const key of NESTED_KEYS) {
    cache[key] = { ...DEFAULTS[key], ...(stored[key] || {}) };
  }
  return cache;
}

export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  for (const key of NESTED_KEYS) {
    if (patch[key]) next[key] = { ...current[key], ...patch[key] };
  }
  cache = next;
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
