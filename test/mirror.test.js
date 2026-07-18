import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oss-mirror-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
process.env.BACKUP_DIR = join(dir, "backup");
process.env.MIRROR_DIR = join(dir, "mirror");
process.env.BACKUP = "true";
process.env.MIRROR = "true";

const config = await import("../src/config.js");
const backup = await import("../src/backup.js");

config.ensureDirs();
writeFileSync(join(config.VAULT_DIR, "note.md"), "mirror me\n");

after(() => {
  backup.stop();
  rmSync(dir, { recursive: true, force: true });
});

function mirrorFiles() {
  return readdirSync(config.MIRROR_DIR).filter((f) => f.endsWith(".tar.gz"));
}

test("a snapshot is copied to the mirror destination", async () => {
  const r = await backup.runBackup();
  assert.equal(r.ok, true);
  assert.ok(mirrorFiles().includes(r.name), "snapshot should be mirrored");
  const st = backup.status();
  assert.equal(st.mirror.enabled, true);
  assert.equal(st.mirror.count, 1);
});

test("the mirror is pruned by retention", async () => {
  backup.configure({ retention: 1 });
  await backup.runBackup();
  assert.equal(mirrorFiles().length, 1, "mirror should keep only the newest");
});
