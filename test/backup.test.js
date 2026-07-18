import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Configure a throwaway environment BEFORE importing the modules.
const dir = mkdtempSync(join(tmpdir(), "oss-backup-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
process.env.BACKUP_DIR = join(dir, "backup");
process.env.BACKUP = "true";

const config = await import("../src/config.js");
const backup = await import("../src/backup.js");

config.ensureDirs();
mkdirSync(config.BACKUP_DIR, { recursive: true });
writeFileSync(join(config.VAULT_DIR, "note.md"), "# hello\ncontent\n");

after(() => {
  backup.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("configure rejects an invalid cron expression", () => {
  const r = backup.configure({ schedule: "not a cron" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid-cron");
});

test("configure rejects an out-of-range retention", () => {
  assert.equal(backup.configure({ retention: 0 }).error, "invalid-retention");
  assert.equal(backup.configure({ retention: 999 }).error, "invalid-retention");
});

test("configure accepts a valid schedule + retention", () => {
  const r = backup.configure({ schedule: "0 3 * * *", retention: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.retention, 2);
});

test("listSnapshots is empty before any backup", () => {
  assert.deepEqual(backup.listSnapshots(), []);
});

test("runBackup creates a non-empty snapshot", async () => {
  const r = await backup.runBackup();
  assert.equal(r.ok, true);
  assert.ok(r.size > 0, "snapshot should have bytes");
  assert.ok(existsSync(join(config.BACKUP_DIR, r.name)));
  assert.equal(backup.listSnapshots().length, 1);
  const st = backup.status();
  assert.equal(st.count, 1);
  assert.equal(st.lastRun.ok, true);
});

test("retention prunes oldest snapshots beyond the keep count", async () => {
  // Two pre-existing (older by name) snapshots + the one from the previous test.
  writeFileSync(join(config.BACKUP_DIR, "vault-20200101-000000.tar.gz"), "x");
  writeFileSync(join(config.BACKUP_DIR, "vault-20200102-000000.tar.gz"), "x");
  backup.configure({ retention: 2 });
  const r = await backup.runBackup();
  assert.equal(r.ok, true);
  const names = backup.listSnapshots().map((s) => s.name);
  assert.equal(names.length, 2, "should keep exactly 2 newest");
  assert.ok(!names.includes("vault-20200101-000000.tar.gz"), "oldest must be pruned");
});

test("successive backups get distinct names", async () => {
  backup.configure({ retention: 10 });
  const a = await backup.runBackup();
  const b = await backup.runBackup();
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.name, b.name);
});

test("restoreToStaging extracts a snapshot into a staging folder", async () => {
  const name = backup.listSnapshots()[0].name;
  const r = await backup.restoreToStaging(name);
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(r.path, "note.md")), "restored file should exist in staging");
});

test("restore rejects an unknown snapshot (path-traversal guard)", async () => {
  assert.equal((await backup.restoreToStaging("../../etc/passwd.tar.gz")).error, "unknown-snapshot");
  assert.equal((await backup.restoreToVault("nope.tar.gz", true)).error, "unknown-snapshot");
});

test("restoreToVault requires confirmation and replaces (not merges) the vault", async () => {
  const name = backup.listSnapshots()[0].name;
  assert.equal((await backup.restoreToVault(name, false)).error, "confirm-required");
  // A file created after the snapshot must be gone after a restore (replace).
  writeFileSync(join(config.VAULT_DIR, "added-later.md"), "should not survive\n");
  const r = await backup.restoreToVault(name, true);
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(config.VAULT_DIR, "note.md")), "snapshot content restored");
  assert.ok(!existsSync(join(config.VAULT_DIR, "added-later.md")), "post-snapshot file removed");
});

test("a failed backup (missing vault) leaves no partial snapshot", async () => {
  const before = backup.listSnapshots().length;
  rmSync(config.VAULT_DIR, { recursive: true, force: true });
  const r = await backup.runBackup();
  assert.equal(r.ok, false);
  assert.equal(backup.listSnapshots().length, before, "no partial archive should remain");
});
