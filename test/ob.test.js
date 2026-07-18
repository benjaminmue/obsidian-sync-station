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

test("syncMode defaults to continuous and reflects settings", () => {
  assert.equal(ob.syncMode(), "continuous");
  config.saveSettings({ sync: { mode: "interval", intervalMinutes: 5 } });
  assert.equal(ob.syncMode(), "interval");
  config.saveSettings({ sync: { mode: "continuous" } });
});
