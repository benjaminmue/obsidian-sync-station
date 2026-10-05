// Request guards for the web UI API: session check, origin check for writes
// and a ceiling on failed sign-ins. Kept out of server.js, which starts
// listening on import, so the guards can be tested on their own.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Failed sign-ins allowed per window across all clients. The station has one
// password and no accounts, so a global ceiling is enough, and it cannot be
// dodged by spoofing X-Forwarded-For.
export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_WINDOW_MS = 60_000;

export function registerRequestGuards(app, { publicRoutes, isAuthed }) {
  // Requests that change something must come from the web UI itself. The
  // session cookie is SameSite=Lax, which stops other sites but not another
  // service on the same host under a different port: that counts as the same
  // site. Browsers send Sec-Fetch-Site over HTTPS and to localhost, and Origin
  // with every write on plain HTTP. Neither header means no browser is
  // involved (curl, scripts), so there is no ambient cookie to abuse.
  app.addHook("onRequest", async (request, reply) => {
    if (SAFE_METHODS.has(request.method)) return;
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined) {
      if (site === "same-origin" || site === "none") return;
      return reply.code(403).send({ error: "cross-origin-request" });
    }
    const origin = request.headers.origin;
    if (origin === undefined) return;
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (originHost !== request.host) {
      return reply.code(403).send({ error: "cross-origin-request" });
    }
  });

  // The decision is made on the route the router matched, never on the raw
  // URL. The router decodes the path and the raw URL is not decoded, so a
  // check on request.url let `/%61pi/settings` reach /api/settings without a
  // session. Anything that did not match an API route is the static web UI.
  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/") || publicRoutes.has(route)) return;
    if (!isAuthed(request, reply)) return reply.code(401).send({ error: "unauthorized" });
  });
}

// Counts failed sign-ins in a fixed window. `blocked()` is checked before the
// password is verified, so a flood is refused before the expensive scrypt run.
export function createLoginLimiter({ limit = LOGIN_FAILURE_LIMIT, windowMs = LOGIN_WINDOW_MS, now = Date.now } = {}) {
  let windowStart = now();
  let failures = 0;
  const roll = () => {
    if (now() - windowStart >= windowMs) {
      windowStart = now();
      failures = 0;
    }
  };
  return {
    blocked() {
      roll();
      return failures >= limit;
    },
    fail() {
      roll();
      failures += 1;
    },
    retryAfterSeconds() {
      return Math.max(1, Math.ceil((windowStart + windowMs - now()) / 1000));
    },
  };
}
