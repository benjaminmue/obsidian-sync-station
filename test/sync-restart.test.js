import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "oss-restart-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");

// Fake ob: `sync --continuous` runs until SIGTERM; any other call exits 0.
const fakeOb = join(dir, "fake-ob");
writeFileSync(
  fakeOb,
  '#!/bin/sh\ncase "$*" in\n  *--continuous*) trap "exit 0" TERM; while true; do sleep 0.1; done ;;\n  *) echo "Fully synced"; exit 0 ;;\nesac\n',
  { mode: 0o755 }
);
process.env.OB_BIN = fakeOb;

const config = await import("../src/config.js");
config.ensureDirs();
config.saveSettings({ vaultLinked: true, sync: { mode: "continuous" } });

const ob = await import("../src/ob.js");

after(() => {
  ob.stopSync();
  rmSync(dir, { recursive: true, force: true });
});

test("switching continuous->interval waits for exit and does not leave sync stopped", async () => {
  ob.startSync(); // continuous
  assert.ok(await waitFor(() => ob.syncRunning()), "continuous sync should start");

  // Simulate the settings handler applying a mode change while running.
  config.saveSettings({ sync: { mode: "interval", intervalMinutes: 1 } });
  await ob.stopSync(); // must resolve only after the continuous child exits
  ob.startSync(); // re-arm in the new mode

  assert.equal(ob.syncMode(), "interval");
  assert.ok(await waitFor(() => ob.syncRunning()), "interval mode should be active after the switch");
});
