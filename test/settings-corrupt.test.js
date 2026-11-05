import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A settings.json that exists but does not parse must fail closed: falling
// back to defaults drops the password hash and reopens first-run setup.
const dir = mkdtempSync(join(tmpdir(), "oss-corrupt-"));
const configDir = join(dir, "config");
process.env.CONFIG_DIR = configDir;
process.env.VAULT_DIR = join(dir, "vault");
process.env.OB_BIN = "/nonexistent/ob";

const settingsFile = join(configDir, "settings.json");
// What a crash during an in-place write used to leave behind.
const CORRUPT = '{"guiPasswordHash": "scrypt$abc$def", "deviceN';
mkdirSync(configDir, { recursive: true });
writeFileSync(settingsFile, CORRUPT);

const config = await import("../src/config.js");
const { buildApp } = await import("../src/server.js");
config.ensureDirs();
const app = await buildApp();

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test("setup is refused and the station reports the problem", async () => {
  const setup = await app.inject({ method: "POST", url: "/api/setup-password", payload: { password: "not-the-owner" } });
  assert.equal(setup.statusCode, 503);
  assert.deepEqual(setup.json(), { error: "settings-unreadable" });
  assert.equal(setup.cookies.length, 0, "no session for anyone");

  const state = (await app.inject({ method: "GET", url: "/api/state" })).json();
  assert.equal(state.settingsError, true);
  assert.equal(state.setupNeeded, false, "the UI must not offer setup");
  assert.equal(state.authed, false);
});

test("sign-in is impossible", async () => {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { password: "anything-at-all" } });
  assert.equal(res.statusCode, 503);
});

test("the corrupt file is never overwritten and a copy is kept", () => {
  assert.equal(readFileSync(settingsFile, "utf8"), CORRUPT);
  assert.throws(() => config.saveSettings({ deviceName: "x" }), { code: "SETTINGS_UNREADABLE" });
  assert.equal(readFileSync(settingsFile, "utf8"), CORRUPT);
  const copies = readdirSync(configDir).filter((f) => f.startsWith("settings.json.corrupt-"));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(configDir, copies[0]), "utf8"), CORRUPT);
});
