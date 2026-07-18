import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point config at a throwaway dir BEFORE importing the module (it reads env at
// import time). node --test isolates each test file in its own process.
const dir = mkdtempSync(join(tmpdir(), "oss-config-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");

const config = await import("../src/config.js");

after(() => rmSync(dir, { recursive: true, force: true }));

test("ensureDirs creates config, ob-home and vault dirs", () => {
  config.ensureDirs();
  assert.ok(existsSync(config.CONFIG_DIR));
  assert.ok(existsSync(config.OB_HOME));
  assert.ok(existsSync(config.VAULT_DIR));
});

test("loadSettings returns defaults on first load", () => {
  const s = config.loadSettings();
  assert.equal(s.guiPasswordHash, null);
  assert.equal(s.encryption, "standard");
  assert.equal(s.backup.retention, 7);
  assert.equal(s.backup.schedule, "0 3 * * *");
});

test("saveSettings persists and merges nested backup settings", () => {
  config.saveSettings({ deviceName: "tower" });
  config.saveSettings({ backup: { retention: 3 } });
  const s = config.loadSettings();
  assert.equal(s.deviceName, "tower");
  assert.equal(s.backup.retention, 3);
  // schedule must survive the partial backup patch
  assert.equal(s.backup.schedule, "0 3 * * *");
  // and it must be on disk
  const onDisk = JSON.parse(readFileSync(join(config.CONFIG_DIR, "settings.json"), "utf8"));
  assert.equal(onDisk.deviceName, "tower");
  assert.equal(onDisk.backup.retention, 3);
});
