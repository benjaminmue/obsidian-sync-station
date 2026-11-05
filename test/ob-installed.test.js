import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// isInstalled() backs the public /api/state, so it must not spawn `ob` for
// every request. A fake ob counts its own invocations and exits with the code
// stored in a file, so one test can flip it from missing to installed.
const dir = mkdtempSync(join(tmpdir(), "oss-installed-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
const counter = join(dir, "calls");
const codeFile = join(dir, "code");
const fakeOb = join(dir, "fake-ob");
writeFileSync(fakeOb, `#!/bin/sh\necho x >> "${counter}"\nexit "$(cat "${codeFile}")"\n`, { mode: 0o755 });
process.env.OB_BIN = fakeOb;

const ob = await import("../src/ob.js");

const calls = () => (existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0);

after(() => {
  mock.timers.reset();
  rmSync(dir, { recursive: true, force: true });
});

test("isInstalled caches a negative result for 10 s and a positive one for good", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

  writeFileSync(codeFile, "1");
  for (let i = 0; i < 5; i++) assert.equal(await ob.isInstalled(), false);
  assert.equal(calls(), 1, "repeated calls within the TTL spawn ob once");

  mock.timers.tick(9_000);
  assert.equal(await ob.isInstalled(), false);
  assert.equal(calls(), 1, "still within the TTL");

  // ob shows up later (e.g. the user waits on the "not installed" screen).
  writeFileSync(codeFile, "0");
  mock.timers.tick(2_000);
  assert.equal(await ob.isInstalled(), true);
  assert.equal(calls(), 2, "an expired negative result is checked again");

  mock.timers.tick(24 * 60 * 60 * 1000);
  for (let i = 0; i < 5; i++) assert.equal(await ob.isInstalled(), true);
  assert.equal(calls(), 2, "a positive result is never re-checked");
});
