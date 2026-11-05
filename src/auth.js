// GUI access control. The web UI handles Obsidian credentials and the optional
// decryption password, so it must be gated itself. LAN-only by design; never
// expose this to the internet.

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { loadSettings, saveSettings, settingsUnreadable } from "./config.js";

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const derived = scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expected, "hex");
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

export function getCookieSecret() {
  const settings = loadSettings();
  if (settings.cookieSecret) return settings.cookieSecret;
  // Unreadable settings cannot be written. Nobody can sign in in that state
  // anyway, so a throwaway secret for this process is enough.
  if (settingsUnreadable()) return randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  saveSettings({ cookieSecret: secret });
  return secret;
}

// In-memory session store: id -> expiry (epoch ms). A single container
// instance means we do not need a shared store; sessions simply drop on
// restart (user logs in again). The expiry is enforced here as well, because
// the cookie's maxAge is only a request to the browser.
const sessions = new Map();
const SESSION_COOKIE = "oss_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function pruneExpired(now) {
  for (const [id, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(id);
}

export function createSession(request, reply) {
  const now = Date.now();
  pruneExpired(now);
  const id = randomBytes(24).toString("hex");
  sessions.set(id, now + SESSION_TTL_MS);
  reply.setCookie(SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    signed: true,
    // Only over HTTPS (directly or behind a proxy that sets X-Forwarded-Proto,
    // honoured because trustProxy is on). Plain-HTTP LAN access is the default
    // setup, and a Secure cookie would never come back there.
    secure: request.protocol === "https",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return id;
}

// The session id from a validly signed cookie, or null.
function sessionId(request, reply) {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = reply.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

export function destroySession(request, reply) {
  const id = sessionId(request, reply);
  if (id) sessions.delete(id);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function isAuthed(request, reply) {
  const id = sessionId(request, reply);
  if (!id) return false;
  const expiresAt = sessions.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(id);
    return false;
  }
  return true;
}
