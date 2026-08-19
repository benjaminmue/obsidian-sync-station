import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ob.js reads config at import (paths), so give it a throwaway dir.
const dir = mkdtempSync(join(tmpdir(), "oss-ob-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
// Force the binary to a non-existent name so no accidental real ob call happens.
process.env.OB_BIN = "/nonexistent/ob";

const config = await import("../src/config.js");
const ob = await import("../src/ob.js");
config.ensureDirs();

test("setup fails fast when end-to-end is chosen without a password", async () => {
  const r = await ob.setup({ vault: "MyVault", encryption: "end-to-end", password: "" });
  assert.deepEqual(r, { ok: false, error: "encryption-password-required" });
});

test("syncRunning is false before any sync is started", () => {
  assert.equal(ob.syncRunning(), false);
});

test("syncBusy is false and syncNextRunAt is null before any sync", () => {
  assert.equal(ob.syncBusy(), false);
  assert.equal(ob.syncNextRunAt(), null);
});

test("a command against a missing binary returns ok:false, not a throw", async () => {
  const r = await ob.listRemote();
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === "string");
});

test("classifySyncExit suppresses a single transient startup exit", () => {
  // First quick exit (e.g. at boot) must not notify.
  assert.deepEqual(ob.classifySyncExit(500, 0), { notify: false, quickFailures: 1 });
});

test("classifySyncExit notifies after repeated startup failures", () => {
  assert.deepEqual(ob.classifySyncExit(500, 1), { notify: false, quickFailures: 2 });
  assert.deepEqual(ob.classifySyncExit(500, 2), { notify: true, quickFailures: 3 });
});

test("classifySyncExit notifies on a crash after running past the grace window", () => {
  assert.deepEqual(ob.classifySyncExit(60000, 2), { notify: true, quickFailures: 0 });
});

test("parseVaultList parses the real sync-list-remote format", () => {
  const out = 'Fetching vaults...\n\nVaults:\n  acc3762724a05ce29e1a933694aaafa7  "O-Vault"  (Europe)\n';
  assert.deepEqual(ob.parseVaultList(out), [
    { id: "acc3762724a05ce29e1a933694aaafa7", name: "O-Vault", region: "Europe" },
  ]);
});

test("parseVaultList handles multiple vaults, spaces in names, and no region", () => {
  const out = [
    "Vaults:",
    '  aaa111  "My Notes"  (US)',
    '  bbb222  "Work Vault"',
  ].join("\n");
  assert.deepEqual(ob.parseVaultList(out), [
    { id: "aaa111", name: "My Notes", region: "US" },
    { id: "bbb222", name: "Work Vault", region: "" },
  ]);
});

test("parseVaultList returns [] when nothing matches", () => {
  assert.deepEqual(ob.parseVaultList("No account logged in."), []);
  assert.deepEqual(ob.parseVaultList(""), []);
});

test("syncMode defaults to continuous and reflects settings", () => {
  assert.equal(ob.syncMode(), "continuous");
  config.saveSettings({ sync: { mode: "interval", intervalMinutes: 5 } });
  assert.equal(ob.syncMode(), "interval");
  config.saveSettings({ sync: { mode: "continuous" } });
});

// --- Permission diagnostics -------------------------------------------------
// `ob` aborts the entire sync run on a single EACCES and only leaves a Node
// stack trace behind. parsePermissionError turns that into something the UI can
// name. The sample below is the real shape logged by ob v0.0.14.

const EACCES_SAMPLE = `Sync failed: Error: EACCES: permission denied, open '/vault/20-knowledge/m365-tenant-security-assessment.md'
    at async open (node:internal/fs/promises:639:25)
    at async Object.writeFile (node:internal/fs/promises:1222:14)
    at async Zi.syncFileDown (/config/npm-global/lib/node_modules/obsidian-headless/cli.js:146:26547) {
  errno: -13,
  code: 'EACCES',
  syscall: 'open',
  path: '/vault/20-knowledge/m365-tenant-security-assessment.md'
}`;

test("parsePermissionError extracts the blocked path from an ob stack trace", () => {
  const found = ob.parsePermissionError(EACCES_SAMPLE);
  assert.deepEqual(found, { paths: ["/vault/20-knowledge/m365-tenant-security-assessment.md"] });
});

test("parsePermissionError deduplicates repeats of the same file", () => {
  // ob prints the failure twice per run (once per handler), the UI must not.
  const found = ob.parsePermissionError(EACCES_SAMPLE + "\n" + EACCES_SAMPLE);
  assert.equal(found.paths.length, 1);
});

test("parsePermissionError collects several distinct files", () => {
  const text = [
    "Error: EACCES: permission denied, open '/vault/a.md'",
    "Error: EPERM: permission denied, open '/vault/b.md'",
  ].join("\n");
  assert.deepEqual(ob.parsePermissionError(text), { paths: ["/vault/a.md", "/vault/b.md"] });
});

test("parsePermissionError ignores unrelated failures", () => {
  assert.equal(ob.parsePermissionError("Sync failed: Error: ENOSPC: no space left on device"), null);
  assert.equal(ob.parsePermissionError("Disconnected from server"), null);
  assert.equal(ob.parsePermissionError(""), null);
});

test("no permission issue is reported before anything failed", () => {
  assert.equal(ob.syncPermissionIssue(), null);
});

test("createLineSplitter reassembles a stack trace split across chunks", () => {
  // Continuous mode reads arbitrary byte chunks; the EACCES line can arrive in
  // two pieces, and only the reassembled line matches the detector.
  const s = ob.createLineSplitter();
  assert.deepEqual(s.push("Error: EACCES: permission de"), []);
  const lines = s.push("nied, open '/vault/a.md'\nnext line\n");
  assert.deepEqual(lines, ["Error: EACCES: permission denied, open '/vault/a.md'", "next line"]);
  assert.deepEqual(ob.parsePermissionError(lines[0]), { paths: ["/vault/a.md"] });
});

test("createLineSplitter holds a partial line until it is complete", () => {
  const s = ob.createLineSplitter();
  assert.deepEqual(s.push("tail without newline"), []);
  assert.deepEqual(s.flush(), ["tail without newline"]);
  assert.deepEqual(s.flush(), [], "flush must not repeat itself");
});

test("createLineSplitter handles CRLF and empty chunks", () => {
  const s = ob.createLineSplitter();
  assert.deepEqual(s.push("a\r\nb\r\n"), ["a", "b"]);
  assert.deepEqual(s.push(""), []);
});

test("stdout and stderr get their own splitter (no glued half-lines)", () => {
  // ob interleaves status on stdout with stack traces on stderr; a shared
  // fragment buffer would splice halves of two different lines together.
  const out = ob.createLineSplitter();
  const err = ob.createLineSplitter();
  assert.deepEqual(out.push("Waiting to conn"), []);
  const errLines = err.push("Error: EACCES: permission denied, open '/vault/a.md'\n");
  assert.deepEqual(ob.parsePermissionError(errLines[0]), { paths: ["/vault/a.md"] });
  assert.deepEqual(out.push("ect to server\n"), ["Waiting to connect to server"]);
});

test("parsePermissionError keeps apostrophes in the path (Obsidian note names)", () => {
  // Node quotes the path but does not escape quotes inside it.
  const text = "Sync failed: Error: EACCES: permission denied, open '/vault/Bob's note.md'";
  assert.deepEqual(ob.parsePermissionError(text), { paths: ["/vault/Bob's note.md"] });
});

test("parsePermissionError ignores trailing tokens after the quoted path", () => {
  const text = "Error: EACCES: permission denied, open '/vault/a.md' {";
  assert.deepEqual(ob.parsePermissionError(text), { paths: ["/vault/a.md"] });
});
