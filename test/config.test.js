import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
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

test("saveSettings writes atomically: no temp file left, owner-only mode", () => {
  config.saveSettings({ deviceName: "atomic" });
  const file = join(config.CONFIG_DIR, "settings.json");
  assert.deepEqual(readdirSync(config.CONFIG_DIR).filter((f) => f.startsWith("settings.json")), ["settings.json"]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).deviceName, "atomic");
});

test("a failed write leaves the previous settings.json intact", () => {
  const file = join(config.CONFIG_DIR, "settings.json");
  const before = readFileSync(file, "utf8");
  // A directory where the temp file goes makes the write fail before rename.
  const tmp = `${file}.tmp`;
  mkdirSync(tmp);
  try {
    assert.throws(() => config.saveSettings({ deviceName: "never-written" }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(readFileSync(file, "utf8"), before);
  assert.notEqual(config.loadSettings().deviceName, "never-written", "the cache must not run ahead of the file");
});
