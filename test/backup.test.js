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

// --- "Last run" across restarts ---------------------------------------------
// `lastRun` only ever describes the current process, so after a restart the card
// read "never" even with a week of snapshots on disk. status() therefore also
// reports what is on disk.

test("parseSnapshotStamp reads the local timestamp back out of a snapshot name", () => {
  assert.equal(backup.parseSnapshotStamp("vault-20260823-030000-193.tar.gz"), "2026-08-23T03:00:00");
  // The collision suffix from uniqueTarget() must not get in the way.
  assert.equal(backup.parseSnapshotStamp("vault-20260823-030000-193-1.tar.gz"), "2026-08-23T03:00:00");
});

test("parseSnapshotStamp rejects names without a usable stamp", () => {
  // 02-31 is the interesting one: Date silently rolls it over to March instead
  // of failing, so a plain NaN check would let it through.
  const bad = [
    "vault-nope.tar.gz",
    "other-20260823-030000-000.tar.gz",
    "",
    "vault-20261345-030000-000.tar.gz",
    "vault-20260231-030000-000.tar.gz",
    "vault-20260823-256100-000.tar.gz",
  ];
  for (const name of bad) {
    assert.equal(backup.parseSnapshotStamp(name), null, `should reject ${name}`);
  }
});

test("a restarted process reports the newest snapshot instead of 'never'", async () => {
  // Fresh vault: the failing test above removed it.
  mkdirSync(config.VAULT_DIR, { recursive: true });
  writeFileSync(join(config.VAULT_DIR, "note.md"), "# hello\n");
  await backup.runBackup();

  // A second module instance stands in for a container restart: same snapshots
  // on disk, but its own `lastRun` starts out null.
  const restarted = await import("../src/backup.js?restart=1");
  const st = restarted.status();
  assert.equal(st.lastRun, null, "a fresh process has not observed a run");
  assert.ok(st.count > 0, "snapshots are on disk");
  assert.match(st.lastSnapshotAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  // Taken from the archive's mtime, which marks completion just like lastRun,
  // so the same backup does not read earlier after a restart than before it.
  const { localTimestamp } = await import("../src/time.js");
  const newest = restarted.listSnapshots()[0];
  assert.equal(st.lastSnapshotAt, localTimestamp(new Date(newest.mtime)));
});

test("status reports no snapshot date once the backup dir is empty", async () => {
  for (const s of backup.listSnapshots()) rmSync(join(config.BACKUP_DIR, s.name));
  assert.equal(backup.status().lastSnapshotAt, null);
});
