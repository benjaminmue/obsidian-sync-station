import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ob.js reads config at import (paths), so give it a throwaway dir.
const dir = mkdtempSync(join(tmpdir(), "oss-ob-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
// Force the binary to a non-existent name so no accidental real ob call happens.
process.env.OB_BIN = "/nonexistent/ob";

const config = await import("../src/config.js");
const ob = await import("../src/ob.js");
config.ensureDirs();

test("setup fails fast when end-to-end is chosen without a password", async () => {
  const r = await ob.setup({ vault: "MyVault", encryption: "end-to-end", password: "" });
  assert.deepEqual(r, { ok: false, error: "encryption-password-required" });
});

test("syncRunning is false before any sync is started", () => {
  assert.equal(ob.syncRunning(), false);
});

test("syncBusy is false and syncNextRunAt is null before any sync", () => {
  assert.equal(ob.syncBusy(), false);
  assert.equal(ob.syncNextRunAt(), null);
});

test("a command against a missing binary returns ok:false, not a throw", async () => {
  const r = await ob.listRemote();
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === "string");
});

test("classifySyncExit suppresses a single transient startup exit", () => {
  // First quick exit (e.g. at boot) must not notify.
  assert.deepEqual(ob.classifySyncExit(500, 0), { notify: false, quickFailures: 1 });
});

test("classifySyncExit notifies after repeated startup failures", () => {
  assert.deepEqual(ob.classifySyncExit(500, 1), { notify: false, quickFailures: 2 });
  assert.deepEqual(ob.classifySyncExit(500, 2), { notify: true, quickFailures: 3 });
});

test("classifySyncExit notifies on a crash after running past the grace window", () => {
  assert.deepEqual(ob.classifySyncExit(60000, 2), { notify: true, quickFailures: 0 });
});

test("parseVaultList parses the real sync-list-remote format", () => {
  const out = 'Fetching vaults...\n\nVaults:\n  acc3762724a05ce29e1a933694aaafa7  "O-Vault"  (Europe)\n';
  assert.deepEqual(ob.parseVaultList(out), [
    { id: "acc3762724a05ce29e1a933694aaafa7", name: "O-Vault", region: "Europe" },
  ]);
});

test("parseVaultList handles multiple vaults, spaces in names, and no region", () => {
  const out = [
    "Vaults:",
    '  aaa111  "My Notes"  (US)',
    '  bbb222  "Work Vault"',
  ].join("\n");
  assert.deepEqual(ob.parseVaultList(out), [
    { id: "aaa111", name: "My Notes", region: "US" },
    { id: "bbb222", name: "Work Vault", region: "" },
  ]);
});

test("parseVaultList returns [] when nothing matches", () => {
  assert.deepEqual(ob.parseVaultList("No account logged in."), []);
  assert.deepEqual(ob.parseVaultList(""), []);
});

test("syncMode defaults to continuous and reflects settings", () => {
  assert.equal(ob.syncMode(), "continuous");
  config.saveSettings({ sync: { mode: "interval", intervalMinutes: 5 } });
  assert.equal(ob.syncMode(), "interval");
  config.saveSettings({ sync: { mode: "continuous" } });
});
