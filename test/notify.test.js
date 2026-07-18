import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "oss-notify-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");

const config = await import("../src/config.js");
const notify = await import("../src/notify.js");

config.ensureDirs();

let calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  calls.push({ url, opts });
  return { ok: true, status: 200 };
};

beforeEach(() => {
  calls = [];
});

after(() => {
  global.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

test("no notification is sent when no URL is configured", async () => {
  config.saveSettings({ notify: { url: "", onBackup: true, onError: true } });
  assert.equal(await notify.notifyBackup("hi"), false);
  assert.equal(calls.length, 0);
});

test("notifyBackup posts the message to the configured topic", async () => {
  config.saveSettings({ notify: { url: "http://ntfy.test/topic", onBackup: true, onError: true } });
  const ok = await notify.notifyBackup("snapshot done");
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ntfy.test/topic");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.body, "snapshot done");
  assert.equal(calls[0].opts.headers.Title, "Obsidian backup");
});

test("notifyBackup is suppressed when onBackup is off", async () => {
  config.saveSettings({ notify: { url: "http://ntfy.test/topic", onBackup: false, onError: true } });
  assert.equal(await notify.notifyBackup("x"), false);
  assert.equal(calls.length, 0);
});

test("a Bearer token is sent when configured", async () => {
  config.saveSettings({ notify: { url: "http://ntfy.test/topic", token: "tk_secret", onBackup: true, onError: true } });
  await notify.notifyBackup("x");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer tk_secret");
});

test("no Authorization header when no token is set", async () => {
  config.saveSettings({ notify: { url: "http://ntfy.test/topic", token: "", onBackup: true, onError: true } });
  await notify.notifyBackup("x");
  assert.equal(calls[0].opts.headers.Authorization, undefined);
});

test("notifyError uses high priority and a warning tag", async () => {
  config.saveSettings({ notify: { url: "http://ntfy.test/topic", onBackup: true, onError: true } });
  await notify.notifyError("boom");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Priority, "high");
  assert.equal(calls[0].opts.headers.Tags, "warning");
});
