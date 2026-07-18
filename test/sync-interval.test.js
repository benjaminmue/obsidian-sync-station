import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

const dir = mkdtempSync(join(tmpdir(), "oss-interval-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");

// A fake `ob` that succeeds instantly, so we can exercise interval mode without
// the real client or network.
const fakeOb = join(dir, "fake-ob");
writeFileSync(fakeOb, '#!/bin/sh\necho "Fully synced"\nexit 0\n', { mode: 0o755 });
process.env.OB_BIN = fakeOb;

const config = await import("../src/config.js");
config.ensureDirs();
config.saveSettings({ vaultLinked: true, sync: { mode: "interval", intervalMinutes: 1 } });

const ob = await import("../src/ob.js");

after(() => {
  ob.stopSync();
  rmSync(dir, { recursive: true, force: true });
});

test("interval mode runs a one-shot sync immediately, then is stoppable", async () => {
  assert.equal(ob.syncMode(), "interval");
  ob.startSync();
  // The immediate one-shot should show up in the log.
  const ran = await waitFor(() => ob.syncLogs().some((l) => /one-shot sync|Fully synced/.test(l.line)));
  assert.ok(ran, "a one-shot sync should have run immediately");
  assert.equal(ob.syncRunning(), true, "interval scheduler should be active");
  // Stopping clears the scheduler; any in-flight one-shot settles shortly after.
  ob.stopSync();
  assert.ok(await waitFor(() => ob.syncRunning() === false), "sync should stop");
});
