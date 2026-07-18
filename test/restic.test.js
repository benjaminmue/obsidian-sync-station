import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "oss-restic-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
process.env.RESTIC_REPOSITORY = join(dir, "repo");
process.env.RESTIC_PASSWORD = "test-pw";

const config = await import("../src/config.js");
const restic = await import("../src/restic.js");

// These tests need the restic binary; skip cleanly if it is not installed.
let hasRestic = false;
before(async () => {
  try {
    execFileSync("restic", ["version"], { stdio: "ignore" });
    hasRestic = true;
  } catch {
    hasRestic = false;
  }
  config.ensureDirs();
  writeFileSync(join(config.VAULT_DIR, "note.md"), "restic me\n");
});

after(() => rmSync(dir, { recursive: true, force: true }));

test("restic is enabled when RESTIC_REPOSITORY is set", () => {
  assert.equal(restic.enabled(), true);
});

test("backup initializes the repo and creates a snapshot", { skip: !hasRestic ? "restic not installed" : false }, async () => {
  const r = await restic.backup();
  assert.equal(r.ok, true, r.error);
  const snaps = await restic.snapshots();
  assert.ok(snaps.length >= 1);
  assert.ok(snaps[0].id && snaps[0].time);
});

test("retention forgets old restic snapshots (keep-last)", { skip: !hasRestic ? "restic not installed" : false }, async () => {
  config.saveSettings({ backup: { retention: 1 } });
  await restic.backup();
  await restic.backup();
  const snaps = await restic.snapshots();
  assert.equal(snaps.length, 1, "should keep exactly the newest");
});

test("restore extracts a snapshot to staging; unknown id is rejected", { skip: !hasRestic ? "restic not installed" : false }, async () => {
  assert.equal((await restic.restore("deadbeef")).error, "unknown-snapshot");
  const id = (await restic.snapshots())[0].id;
  const r = await restic.restore(id);
  assert.equal(r.ok, true, r.error);
  // restic restores the absolute source path under the target dir.
  const found = execFileSync("find", [r.path, "-name", "note.md"]).toString().trim();
  assert.ok(found.length > 0, "note.md should be restored somewhere under staging");
});
