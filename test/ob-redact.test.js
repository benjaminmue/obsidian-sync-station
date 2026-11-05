import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A failing ob must never hand a password back to the UI. Node's err.message
// carries the full command line, --password included; ob itself may also echo
// its arguments. The fake ob covers both: `login` prints its arguments to
// stderr, `sync-setup` fails silently so only the exit code is left.
const dir = mkdtempSync(join(tmpdir(), "oss-redact-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
const fakeOb = join(dir, "fake-ob");
writeFileSync(
  fakeOb,
  '#!/bin/sh\ncase "$1" in\n  login) echo "login rejected: $*" >&2; exit 1 ;;\n  *) exit 3 ;;\nesac\n',
  { mode: 0o755 },
);
process.env.OB_BIN = fakeOb;

const ob = await import("../src/ob.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const PASSWORD = "hunter2-super-secret";

test("a failed login does not return the password, even when ob echoes it", async () => {
  const r = await ob.login({ email: "me@example.com", password: PASSWORD, mfa: "123456" });
  assert.equal(r.ok, false);
  assert.ok(!r.error.includes(PASSWORD), r.error);
  assert.ok(!r.error.includes("123456"), r.error);
  assert.match(r.error, /login rejected/);
  assert.match(r.error, /\*\*\*/);
});

test("a failure without output reports the exit code, not the command line", async () => {
  const r = await ob.setup({ vault: "MyVault", encryption: "end-to-end", password: PASSWORD });
  assert.deepEqual(r, { ok: false, error: "ob exited with code 3" });
});

test("redact masks every occurrence and ignores empty secrets", () => {
  assert.equal(ob.redact("a pw b pw", ["pw", "", undefined]), "a *** b ***");
  assert.equal(ob.redact("nothing here", []), "nothing here");
});
