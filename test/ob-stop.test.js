import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

const dir = mkdtempSync(join(tmpdir(), "oss-stop-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");

// Fake ob: a one-shot `sync` that takes long (like a big initial pull) and
// records its pid. `exec` makes the pid the sleeping process itself.
const pidFile = join(dir, "pid");
const fakeOb = join(dir, "fake-ob");
writeFileSync(fakeOb, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
process.env.OB_BIN = fakeOb;

const config = await import("../src/config.js");
config.ensureDirs();
config.saveSettings({ vaultLinked: true, sync: { mode: "interval", intervalMinutes: 60 } });

const ob = await import("../src/ob.js");
const { withLock, RESTORE_VAULT } = await import("../src/lock.js");

after(async () => {
  await ob.stopSync();
  rmSync(dir, { recursive: true, force: true });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("stopSync terminates a running interval one-shot and resolves only after it exited", async () => {
  ob.startSync();
  assert.ok(await waitFor(() => existsSync(pidFile) && ob.syncBusy()), "one-shot should be running");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(alive(pid));

  await ob.stopSync();
  assert.equal(alive(pid), false, "the one-shot must be gone when stopSync resolves");
  assert.ok(await waitFor(() => ob.syncRunning() === false));
  // A deliberate stop is logged as such, not as a sync failure.
  assert.ok(await waitFor(() => ob.syncLogs().some((l) => /one-shot sync stopped/.test(l.line))));
  assert.ok(!ob.syncLogs().some((l) => /sync failed/.test(l.line)));
});

test("sync cannot be started while a restore into the vault holds the lock", async () => {
  let started;
  await withLock(RESTORE_VAULT, async () => {
    started = ob.startSync();
  });
  assert.deepEqual(started, { ok: false, error: "busy", busyWith: RESTORE_VAULT });
  assert.equal(ob.syncRunning(), false);
});
