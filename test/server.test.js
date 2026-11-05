import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs against the real route table from buildApp(), so a route added without
// thinking about authentication shows up here.
const dir = mkdtempSync(join(tmpdir(), "oss-server-"));
process.env.CONFIG_DIR = join(dir, "config");
process.env.VAULT_DIR = join(dir, "vault");
process.env.BACKUP_DIR = join(dir, "backup");
process.env.BACKUP = "true";
process.env.OB_BIN = "/nonexistent/ob";

const config = await import("../src/config.js");
const { buildApp } = await import("../src/server.js");
const backup = await import("../src/backup.js");
const { withLock, RESTORE_VAULT } = await import("../src/lock.js");
config.ensureDirs();

const routes = [];
const app = await buildApp({
  onRoute: (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  },
});
await app.ready();

after(async () => {
  await app.close();
  backup.stop();
  rmSync(dir, { recursive: true, force: true });
});

// Intentionally reachable without a session. "/*" is the static web UI.
const PUBLIC = new Set([
  "GET /",
  "HEAD /",
  "GET /index.html",
  "HEAD /index.html",
  "GET /*",
  "HEAD /*",
  "GET /api/health",
  "HEAD /api/health",
  "GET /api/state",
  "HEAD /api/state",
  "POST /api/setup-password",
  "POST /api/login",
]);

const PASSWORD = "station-password";
let cookie;
async function signedIn() {
  if (cookie) return cookie;
  const res = await app.inject({ method: "POST", url: "/api/setup-password", payload: { password: PASSWORD } });
  assert.equal(res.statusCode, 200);
  const c = res.cookies.find((x) => x.name === "oss_session");
  cookie = { oss_session: c.value };
  return cookie;
}

test("every route without a session answers 401, except the public ones", async () => {
  const walked = routes.filter((r) => ["GET", "HEAD", "POST"].includes(r.method));
  assert.ok(walked.length > 30, `expected the full route table, got ${walked.length}`);
  const publicSeen = new Set();
  for (const { method, url } of walked) {
    const key = `${method} ${url}`;
    if (PUBLIC.has(key)) {
      publicSeen.add(key);
      continue;
    }
    const res = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
    assert.equal(res.statusCode, 401, key);
  }
  assert.deepEqual([...publicSeen].sort(), [...PUBLIC].sort(), "public list matches the route table");
});

test("an encoded /api prefix does not bypass the session check", async () => {
  for (const url of ["/%61pi/settings", "/%61%70%69/backup/list", "/api/%73ettings"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, url);
  }
});

test("setup rejects a password that is not a string or too long", async () => {
  // Runs before the station is configured (tests in a file run in order).
  for (const [password, error] of [
    [{ length: 99 }, "password-too-short"],
    [123456789, "password-too-short"],
    ["x".repeat(1025), "password-too-long"],
  ]) {
    const res = await app.inject({ method: "POST", url: "/api/setup-password", payload: { password } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, error);
  }
});

test("anonymous /api/state carries only what setup and sign-in need", async () => {
  const res = await app.inject({ method: "GET", url: "/api/state" });
  assert.deepEqual(Object.keys(res.json()).sort(), ["authed", "obInstalled", "settingsError", "setupNeeded", "version"]);
  const authed = (await app.inject({ method: "GET", url: "/api/state", cookies: await signedIn() })).json();
  assert.equal(authed.authed, true);
  for (const key of ["vaultLinked", "deviceName", "encryption", "syncMode"]) assert.ok(key in authed, key);
});

test("a malformed sign-in password is a failed attempt, never a crash", async () => {
  // A fresh app has a fresh limiter.
  const fresh = await buildApp();
  for (const password of [{ length: 9 }, ["a"], 12345678, "x".repeat(5000)]) {
    const res = await fresh.inject({ method: "POST", url: "/api/login", payload: { password } });
    assert.equal(res.statusCode, 401, JSON.stringify(password).slice(0, 20));
  }
  // They count toward the limiter like wrong passwords.
  for (let i = 0; i < 10; i++) await fresh.inject({ method: "POST", url: "/api/login", payload: { password: 1 } });
  const blocked = await fresh.inject({ method: "POST", url: "/api/login", payload: { password: PASSWORD } });
  assert.equal(blocked.statusCode, 429);
  await fresh.close();
});

test("Obsidian login and vault setup reject non-string or oversized fields", async () => {
  const cookies = await signedIn();
  const cases = [
    ["/api/obsidian/login", { email: ["a@b.c"], password: "pw" }],
    ["/api/obsidian/login", { email: "a@b.c", password: { toString: 1 } }],
    ["/api/obsidian/login", { email: "a@b.c", password: "x".repeat(1025) }],
    ["/api/obsidian/login", { email: "a@b.c", password: "pw", mfa: 123456 }],
    ["/api/obsidian/setup", { vault: { id: 1 } }],
    ["/api/obsidian/setup", { vault: "v", vaultName: ["n"] }],
    ["/api/obsidian/setup", { vault: "v", encryption: "end-to-end", password: 42 }],
    ["/api/obsidian/setup", { vault: "v".repeat(2000) }],
  ];
  for (const [url, payload] of cases) {
    const res = await app.inject({ method: "POST", url, payload, cookies });
    assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload).slice(0, 60)}`);
    assert.equal(res.json().error, "invalid-input");
  }
});

test("restore into the vault refuses while a backup runs, and vice versa", async () => {
  const cookies = await signedIn();
  const name = "vault-20260101-000000.tar.gz";
  writeFileSync(join(config.BACKUP_DIR, name), "placeholder");

  let release;
  const holding = withLock("backup", () => new Promise((r) => (release = r)));
  const restore = await app.inject({
    method: "POST",
    url: "/api/backup/restore-vault",
    payload: { name, confirm: true },
    cookies,
  });
  assert.deepEqual(restore.json(), { ok: false, error: "busy", busyWith: "backup" });
  release({ ok: true });
  await holding;

  await withLock(RESTORE_VAULT, async () => {
    assert.deepEqual(await backup.runBackup(), { ok: false, error: "busy", busyWith: RESTORE_VAULT });
    const manual = await app.inject({ method: "POST", url: "/api/backup/run", cookies });
    assert.equal(manual.json().error, "busy");
    const sync = await app.inject({ method: "POST", url: "/api/sync/start", cookies });
    assert.equal(sync.json().error, "busy");
  });
});
