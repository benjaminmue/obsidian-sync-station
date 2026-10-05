import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRequestGuards, createLoginLimiter } from "../src/guards.js";

// A stand-in for the session check: a request is signed in when it carries
// the header below. The guards only need a yes or no.
const isAuthed = (request) => request.headers["x-test-session"] === "1";

async function buildApp() {
  const app = Fastify();
  registerRequestGuards(app, { publicRoutes: new Set(["/api/health"]), isAuthed });
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/settings", async () => ({ secret: "x" }));
  app.post("/api/settings", async () => ({ ok: true }));
  app.get("/app.js", async () => "static");
  return app;
}

test("an encoded path does not slip past the session check", async () => {
  const app = await buildApp();
  for (const url of ["/api/settings", "/%61pi/settings", "/%61%70%69/settings"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, url);
  }
});

test("public routes and the static UI need no session", async () => {
  const app = await buildApp();
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/app.js" })).statusCode, 200);
});

test("a signed-in request reaches the API", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/api/settings", headers: { "x-test-session": "1" } });
  assert.equal(res.statusCode, 200);
});

test("writes from another origin are refused even with a session", async () => {
  const app = await buildApp();
  const base = { method: "POST", url: "/api/settings", headers: { host: "tower:8484", "x-test-session": "1" } };
  const cases = [
    [{ origin: "http://tower:9000" }, 403],
    [{ origin: "null" }, 403],
    [{ "sec-fetch-site": "same-site" }, 403],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ origin: "http://tower:8484" }, 200],
    [{ "sec-fetch-site": "same-origin" }, 200],
    [{}, 200],
  ];
  for (const [headers, status] of cases) {
    const res = await app.inject({ ...base, headers: { ...base.headers, ...headers } });
    assert.equal(res.statusCode, status, JSON.stringify(headers));
  }
});

test("the login limiter blocks after the limit and opens again with the next window", () => {
  let t = 0;
  const limiter = createLoginLimiter({ limit: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.blocked(), false);
    limiter.fail();
  }
  assert.equal(limiter.blocked(), true);
  t = 400;
  assert.equal(limiter.retryAfterSeconds(), 1);
  t = 1000;
  assert.equal(limiter.blocked(), false);
});
