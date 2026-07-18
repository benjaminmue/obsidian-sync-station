// Obsidian Sync Station — front-end state machine.
// Views are driven entirely by GET /api/state.

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle("hidden", !on);

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET" };
  if (opts.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

function setMsg(id, text, kind) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

const VIEWS = ["view-setup", "view-login", "view-noob", "view-oblogin", "view-vault", "view-dash", "view-backup", "view-restic", "view-settings"];
function only(...ids) {
  for (const v of VIEWS) show(v, ids.includes(v));
}

let logTimer = null;
let backupEnabled = false;
let resticEnabled = false;

async function refresh() {
  const { data: st } = await api("/api/state");
  if (!st) return;
  $("version").textContent = "v" + st.version;

  if (st.setupNeeded) return only("view-setup");
  if (!st.authed) return only("view-login");
  if (!st.obInstalled) {
    only("view-noob");
    setTimeout(refresh, 4000);
    return;
  }

  if (!st.vaultLinked) {
    // Probe the vault list; ok means we are logged in. The CLI prints text, so
    // we show it verbatim and let the user copy the vault name/ID.
    const vaults = await api("/api/obsidian/vaults");
    if (!vaults.data?.ok) return only("view-oblogin");
    $("vault-listing").textContent = vaults.data.text || "(no vaults returned)";
    return only("view-vault");
  }

  // Linked → dashboard, optional backup/restic, settings.
  backupEnabled = st.backupEnabled;
  resticEnabled = st.resticEnabled;
  only(...["view-dash", backupEnabled && "view-backup", resticEnabled && "view-restic", "view-settings"].filter(Boolean));
  $("dash-vault").textContent = st.vaultName || "—";
  $("dash-device").textContent = st.deviceName || "—";
  $("dash-enc").textContent = st.encryption || "—";
  updateSyncBadge(st.syncRunning);
  loadSettingsForm();
  tick();
  if (!logTimer) logTimer = setInterval(tick, 5000);
}

async function tick() {
  await loadLogs();
  if (backupEnabled) await loadBackup();
  if (resticEnabled) await loadRestic();
}

function updateSyncBadge(running) {
  const b = $("sync-badge");
  b.textContent = running ? "running" : "stopped";
  b.className = "badge " + (running ? "on" : "off");
}

async function loadLogs() {
  const { data } = await api("/api/sync/logs");
  if (!data?.logs) return;
  const el = $("sync-logs");
  el.textContent = data.logs.length
    ? data.logs.map((l) => `${l.ts.slice(11, 19)}  ${l.line}`).join("\n")
    : "No logs yet.";
  el.scrollTop = el.scrollHeight;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}

async function loadBackup() {
  const [status, list, logs] = await Promise.all([
    api("/api/backup/status"),
    api("/api/backup/list"),
    api("/api/backup/logs"),
  ]);
  const st = status.data;
  if (st) {
    $("backup-dir").textContent = st.dir || "/backup";
    $("backup-count").textContent = st.count ?? 0;
    $("backup-last").textContent = st.lastRun
      ? `${st.lastRun.ts.slice(0, 19).replace("T", " ")} (${st.lastRun.ok ? "ok" : "failed"})`
      : "never";
    const b = $("backup-badge");
    b.textContent = st.running ? "running" : "idle";
    b.className = "badge " + (st.running ? "on" : "off");
    // Only fill inputs the user is not currently editing.
    if (document.activeElement !== $("backup-cron")) $("backup-cron").value = st.schedule || "";
    if (document.activeElement !== $("backup-retention")) $("backup-retention").value = st.retention ?? "";
    const m = st.mirror;
    $("backup-mirror").textContent = m && m.enabled ? `Mirror: ${m.dir} (${m.count} snapshots)` : "Mirror: disabled";
  }
  renderSnapshots(list.data?.snapshots || []);
  const bl = logs.data?.logs || [];
  const el = $("backup-logs");
  el.textContent = bl.length ? bl.map((l) => `${l.ts.slice(11, 19)}  ${l.line}`).join("\n") : "No logs yet.";
  el.scrollTop = el.scrollHeight;
}

function renderSnapshots(snaps) {
  const el = $("backup-list");
  el.innerHTML = "";
  if (!snaps.length) {
    el.textContent = "None yet.";
    return;
  }
  for (const s of snaps) {
    const row = document.createElement("div");
    row.className = "snap-row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = s.name;
    const sz = document.createElement("span");
    sz.className = "sz";
    sz.textContent = fmtSize(s.size);
    const staging = document.createElement("button");
    staging.className = "secondary";
    staging.textContent = "To staging";
    staging.onclick = () => restore(s.name, "staging");
    const vault = document.createElement("button");
    vault.className = "danger";
    vault.textContent = "To vault";
    vault.onclick = () => restore(s.name, "vault");
    row.append(name, sz, staging, vault);
    el.appendChild(row);
  }
}

async function restore(name, target) {
  if (target === "vault") {
    const ok = confirm(
      `Restore "${name}" over the LIVE vault?\n\n` +
        "This stops sync and overwrites the vault contents. When you restart sync, " +
        "the restored state is pushed to Obsidian's remote and may overwrite newer changes."
    );
    if (!ok) return;
    const { data } = await api("/api/backup/restore-vault", { method: "POST", body: { name, confirm: true } });
    setMsg(
      "backup-msg",
      data?.ok ? "Restored into vault. Sync stopped — restart it from the dashboard when ready." : "Restore failed: " + (data?.error || "unknown"),
      data?.ok ? "ok" : "err"
    );
    refresh();
  } else {
    setMsg("backup-msg", "Restoring to staging…");
    const { data } = await api("/api/backup/restore-staging", { method: "POST", body: { name } });
    setMsg("backup-msg", data?.ok ? "Restored to staging: " + data.path : "Restore failed: " + (data?.error || "unknown"), data?.ok ? "ok" : "err");
  }
}

async function loadSettingsForm() {
  const { data } = await api("/api/settings");
  if (!data) return;
  if (document.activeElement !== $("set-device")) $("set-device").value = data.deviceName || "";
  const n = data.notify || {};
  if (document.activeElement !== $("set-ntfy")) $("set-ntfy").value = n.url || "";
  $("set-notify-backup").checked = !!n.onBackup;
  $("set-notify-error").checked = !!n.onError;
}

async function loadRestic() {
  const [status, list, logs] = await Promise.all([
    api("/api/restic/status"),
    api("/api/restic/snapshots"),
    api("/api/restic/logs"),
  ]);
  const st = status.data;
  if (st) {
    $("restic-repo").textContent = st.repo || "—";
    $("restic-last").textContent = st.lastRun
      ? `${st.lastRun.ts.slice(0, 19).replace("T", " ")} (${st.lastRun.ok ? "ok" : "failed"})`
      : "never";
    const b = $("restic-badge");
    b.textContent = st.running ? "running" : "idle";
    b.className = "badge " + (st.running ? "on" : "off");
  }
  const snaps = list.data?.snapshots || [];
  const el = $("restic-list");
  el.innerHTML = "";
  if (!snaps.length) {
    el.textContent = "None yet.";
  } else {
    for (const s of snaps) {
      const row = document.createElement("div");
      row.className = "snap-row";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${s.id}  ${s.time ? s.time.slice(0, 19).replace("T", " ") : ""}`;
      const btn = document.createElement("button");
      btn.className = "secondary";
      btn.textContent = "Restore to staging";
      btn.onclick = () => resticRestore(s.id);
      row.append(name, btn);
      el.appendChild(row);
    }
  }
  const rl = logs.data?.logs || [];
  const lg = $("restic-logs");
  lg.textContent = rl.length ? rl.map((l) => `${l.ts.slice(11, 19)}  ${l.line}`).join("\n") : "No logs yet.";
  lg.scrollTop = lg.scrollHeight;
}

async function resticRestore(id) {
  setMsg("restic-msg", "Restoring…");
  const { data } = await api("/api/restic/restore", { method: "POST", body: { id } });
  setMsg("restic-msg", data?.ok ? "Restored to staging: " + data.path : "Restore failed: " + (data?.error || "unknown"), data?.ok ? "ok" : "err");
  loadRestic();
}

// --- Event wiring -----------------------------------------------------------

$("setup-btn").onclick = async () => {
  const password = $("setup-pw").value;
  const { status, data } = await api("/api/setup-password", { method: "POST", body: { password } });
  if (status === 200) return refresh();
  setMsg("setup-msg", data?.error === "password-too-short" ? "Password must be at least 8 characters." : "Failed.", "err");
};

$("login-btn").onclick = async () => {
  const password = $("login-pw").value;
  const { status } = await api("/api/login", { method: "POST", body: { password } });
  if (status === 200) return refresh();
  setMsg("login-msg", "Invalid password.", "err");
};

$("oblogin-btn").onclick = async () => {
  setMsg("oblogin-msg", "Logging in…");
  const body = { email: $("ob-email").value, password: $("ob-pw").value, mfa: $("ob-mfa").value };
  const { data } = await api("/api/obsidian/login", { method: "POST", body });
  if (data?.ok) {
    setMsg("oblogin-msg", "Logged in.", "ok");
    return refresh();
  }
  setMsg("oblogin-msg", "Login failed: " + (data?.error || "unknown"), "err");
};

$("vault-enc").onchange = () => show("enc-pw-wrap", $("vault-enc").value === "end-to-end");

$("vault-refresh").onclick = async () => {
  const vaults = await api("/api/obsidian/vaults");
  if (vaults.data?.ok) $("vault-listing").textContent = vaults.data.text || "(no vaults returned)";
  else setMsg("vault-msg", "Could not list vaults: " + (vaults.data?.error || "unknown"), "err");
};

$("vault-link-btn").onclick = async () => {
  const vault = $("vault-name").value.trim();
  const encryption = $("vault-enc").value;
  const password = $("vault-encpw").value;
  if (!vault) return setMsg("vault-msg", "Pick a vault.", "err");
  setMsg("vault-msg", "Linking…");
  const { data } = await api("/api/obsidian/setup", { method: "POST", body: { vault, encryption, password } });
  if (data?.ok) return refresh();
  setMsg("vault-msg", "Setup failed: " + (data?.error || "unknown"), "err");
};

$("sync-start").onclick = async () => { await api("/api/sync/start", { method: "POST" }); refresh(); };
$("sync-stop").onclick = async () => { await api("/api/sync/stop", { method: "POST" }); refresh(); };
$("sync-refresh").onclick = () => refresh();

$("set-save").onclick = async () => {
  const notify = {
    url: $("set-ntfy").value,
    onBackup: $("set-notify-backup").checked,
    onError: $("set-notify-error").checked,
  };
  const { data } = await api("/api/settings", { method: "POST", body: { deviceName: $("set-device").value, notify } });
  setMsg("set-msg", data?.ok ? "Saved." : "Failed.", data?.ok ? "ok" : "err");
};

$("backup-save").onclick = async () => {
  const body = { schedule: $("backup-cron").value, retention: Number($("backup-retention").value) };
  const { data } = await api("/api/backup/config", { method: "POST", body });
  if (data?.ok) setMsg("backup-msg", "Schedule saved.", "ok");
  else setMsg("backup-msg", "Invalid: " + (data?.error || "unknown"), "err");
  loadBackup();
};

$("backup-run").onclick = async () => {
  setMsg("backup-msg", "Running backup…");
  const { data } = await api("/api/backup/run", { method: "POST" });
  if (data?.ok) setMsg("backup-msg", `Snapshot created: ${data.name}`, "ok");
  else setMsg("backup-msg", "Backup failed: " + (data?.error || "unknown"), "err");
  loadBackup();
};

$("restic-run").onclick = async () => {
  setMsg("restic-msg", "Running restic backup…");
  const { data } = await api("/api/restic/run", { method: "POST" });
  setMsg("restic-msg", data?.ok ? "restic backup done." : "restic failed: " + (data?.error || "unknown"), data?.ok ? "ok" : "err");
  loadRestic();
};

$("gui-logout").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  refresh();
};

refresh();
