import { test, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { hashPassword, verifyPassword, createSession, isAuthed } from "../src/auth.js";

test("hashPassword produces a scrypt hash that verifies", () => {
  const hash = hashPassword("correct horse battery");
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword("correct horse battery", hash), true);
});

test("verifyPassword rejects wrong password", () => {
  const hash = hashPassword("secret-one");
  assert.equal(verifyPassword("secret-two", hash), false);
});

test("verifyPassword rejects null / malformed stored hash", () => {
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", "not-a-hash"), false);
  assert.equal(verifyPassword("x", "scrypt$onlysalt"), false);
});

test("two hashes of the same password differ (unique salt)", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

// --- Sessions ----------------------------------------------------------------

async function sessionApp() {
  const app = Fastify({ trustProxy: true });
  await app.register(fastifyCookie, { secret: "test-secret" });
  app.post("/login", async (request, reply) => ({ id: createSession(request, reply) }));
  app.get("/check", async (request, reply) => ({ authed: isAuthed(request, reply) }));
  return app;
}

const sessionCookie = (res) => res.cookies.find((c) => c.name === "oss_session");

test("a session is rejected once its 30 days are over, whatever the cookie says", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const app = await sessionApp();
    const cookie = sessionCookie(await app.inject({ method: "POST", url: "/login" }));
    const check = () => app.inject({ method: "GET", url: "/check", cookies: { oss_session: cookie.value } });
    assert.equal((await check()).json().authed, true);
    mock.timers.tick(30 * 24 * 60 * 60 * 1000 - 1);
    assert.equal((await check()).json().authed, true);
    mock.timers.tick(1);
    assert.equal((await check()).json().authed, false);
    await app.close();
  } finally {
    mock.timers.reset();
  }
});

test("the session cookie is Secure over HTTPS and not over plain HTTP", async () => {
  const app = await sessionApp();
  const http = sessionCookie(await app.inject({ method: "POST", url: "/login" }));
  assert.ok(!http.secure, "plain-HTTP LAN access must keep working");
  assert.equal(http.maxAge, 30 * 24 * 60 * 60);
  const https = sessionCookie(
    await app.inject({ method: "POST", url: "/login", headers: { "x-forwarded-proto": "https" } }),
  );
  assert.equal(https.secure, true);
  assert.equal(https.httpOnly, true);
  await app.close();
});
