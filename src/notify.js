// Push notifications via ntfy (https://ntfy.sh / self-hosted). Configured with a
// full topic URL in settings; a POST to that URL delivers the message. All
// failures are swallowed — a notification problem must never break sync/backup.

import { loadSettings } from "./config.js";
import { log } from "./logger.js";

function config() {
  return loadSettings().notify || {};
}

async function send(title, message, { priority = "default", tags = "" } = {}) {
  const { url, token } = config();
  if (!url) return false;
  try {
    const headers = { Title: title, Priority: priority };
    if (tags) headers.Tags = tags;
    // Authenticated ntfy servers (access control) need a Bearer token.
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: "POST", headers, body: message });
    if (!res.ok) log.warn("ntfy non-ok response", { status: res.status });
    return res.ok;
  } catch (err) {
    log.warn("ntfy send failed", { error: err.message });
    return false;
  }
}

export function notifyBackup(message) {
  if (!config().onBackup) return Promise.resolve(false);
  return send("Obsidian backup", message, { tags: "floppy_disk" });
}

export function notifyError(message) {
  if (!config().onError) return Promise.resolve(false);
  return send("Obsidian Sync Station error", message, { priority: "high", tags: "warning" });
}
