import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { registerWebUi, versionAssetUrls } from "../src/webui.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));

async function buildApp() {
  const app = Fastify();
  await registerWebUi(app, { root: join(repo, "public"), version });
  return app;
}

test("versionAssetUrls tags local scripts and stylesheets only", () => {
  const html = [
    '<link rel="stylesheet" href="/styles.css" />',
    '<link rel="icon" href="/logo.svg" />',
    '<script src="/app.js" type="module"></script>',
    '<script src="https://cdn.example/x.js"></script>',
  ].join("\n");
  const out = versionAssetUrls(html, "1.2.3");
  assert.match(out, /href="\/styles\.css\?v=1\.2\.3"/);
  assert.match(out, /src="\/app\.js\?v=1\.2\.3"/);
  assert.match(out, /href="\/logo\.svg"/);
  assert.match(out, /src="https:\/\/cdn\.example\/x\.js"/);
});

test("versionAssetUrls leaves an already versioned URL alone", () => {
  assert.equal(versionAssetUrls('<script src="/app.js?v=1"></script>', "2"), '<script src="/app.js?v=1"></script>');
});

for (const path of ["/", "/index.html"]) {
  test(`${path} serves index.html with versioned asset URLs and no-cache`, async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: path });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-cache");
    assert.match(res.headers["content-type"], /^text\/html/);
    assert.ok(res.body.includes(`src="/app.js?v=${version}"`));
    assert.ok(res.body.includes(`href="/styles.css?v=${version}"`));
    await app.close();
  });
}

test("assets requested with the current version are cached as immutable", async () => {
  const app = await buildApp();
  for (const asset of ["/app.js", "/styles.css"]) {
    const res = await app.inject({ method: "GET", url: `${asset}?v=${version}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
  }
  await app.close();
});

test("unversioned or stale asset URLs must revalidate", async () => {
  const app = await buildApp();
  for (const url of ["/app.js", "/styles.css?v=0.0.1", "/logo.svg"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-cache", url);
  }
  await app.close();
});
