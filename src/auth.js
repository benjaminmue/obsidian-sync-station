// GUI access control. The web UI handles Obsidian credentials and the optional
// decryption password, so it must be gated itself. LAN-only by design; never
// expose this to the internet.

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { loadSettings, saveSettings } from "./config.js";

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
  const secret = randomBytes(32).toString("hex");
  saveSettings({ cookieSecret: secret });
  return secret;
}

// In-memory session store. A single container instance means we do not need a
// shared store; sessions simply drop on restart (user logs in again).
const sessions = new Set();
const SESSION_COOKIE = "oss_session";

export function createSession(reply) {
  const id = randomBytes(24).toString("hex");
  sessions.add(id);
  reply.setCookie(SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    signed: true,
    maxAge: 60 * 60 * 24 * 30,
  });
  return id;
}

export function destroySession(request, reply) {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw) {
    const unsigned = reply.unsignCookie(raw);
    if (unsigned.valid && unsigned.value) sessions.delete(unsigned.value);
  }
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function isAuthed(request, reply) {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const unsigned = reply.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? sessions.has(unsigned.value) : false;
}
