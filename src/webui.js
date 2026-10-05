// Serves the static web UI. index.html gets the running version appended to
// its local script and stylesheet URLs, so a container update changes the
// asset URLs and browsers cannot keep running a stale app.js or styles.css.

import fastifyStatic from "@fastify/static";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

// Appends `?v=<version>` to every root-relative .js/.css href or src.
export function versionAssetUrls(html, version) {
  const v = encodeURIComponent(version);
  return html.replace(/((?:href|src)="\/[^"?#]+\.(?:js|css))"/g, `$1?v=${v}"`);
}

export async function registerWebUi(app, { root, version }) {
  const indexHtml = versionAssetUrls(readFileSync(join(root, "index.html"), "utf8"), version);
  const sendIndex = (_request, reply) =>
    reply.header("Cache-Control", REVALIDATE).type("text/html; charset=utf-8").send(indexHtml);

  app.get("/", sendIndex);
  app.get("/index.html", sendIndex);

  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    index: false,
    cacheControl: false,
    // Only a URL carrying the current version may be cached for good. Anything
    // else (unversioned, or an old version from a stale page) revalidates.
    setHeaders: (reply) => {
      const pinned = reply.request.query.v === version;
      reply.header("Cache-Control", pinned ? IMMUTABLE : REVALIDATE);
    },
  });
}
