// Obsidian Sync Station — front-end state machine.
// Views are driven entirely by GET /api/state.

const $ = (id) => document.getElementById(id);
const show = (id, on) => $(id).classList.toggle("hidden", !on);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
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

const VIEWS = ["view-setup", "view-login", "view-noob", "view-oblogin", "view-vault", "view-dash", "view-backup", "view-settings"];
function only(...ids) {
  for (const v of VIEWS) show(v, ids.includes(v));
}

let logTimer = null;
let backupEnabled = false;

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
    // Need Obsidian login first, then vault selection. We probe the vault list;
    // a 200 with vaults means we are logged in.
    const vaults = await api("/api/obsidian/vaults");
    const list = normalizeVaults(vaults.data);
    if (vaults.status === 401 || vaults.data?.ok === false || list === null) {
      return only("view-oblogin");
    }
    populateVaults(list);
    return only("view-vault");
  }

  // Linked → dashboard, optional backup, settings.
  backupEnabled = st.backupEnabled;
  only(...["view-dash", backupEnabled && "view-backup", "view-settings"].filter(Boolean));
  $("dash-vault").textContent = st.vaultName || "—";
  $("dash-device").textContent = st.deviceName || "—";
  $("dash-enc").textContent = st.encryption || "—";
  $("set-device").value = st.deviceName || "";
  updateSyncBadge(st.syncRunning);
  tick();
  if (!logTimer) logTimer = setInterval(tick, 5000);
}

async function tick() {
  await loadLogs();
  if (backupEnabled) await loadBackup();
}

function normalizeVaults(data) {
  if (!data || data.ok === false) return null;
  const arr = Array.isArray(data) ? data : data.data || data.vaults || data.remotes;
  if (!Array.isArray(arr)) return null;
  return arr.map((v) =>
    typeof v === "string" ? { id: v, name: v } : { id: v.id || v.name || v.vault, name: v.name || v.id || v.vault }
  );
}

function populateVaults(list) {
  const sel = $("vault-select");
  sel.innerHTML = "";
  for (const v of list) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.name;
    sel.appendChild(opt);
  }
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
  }
  const snaps = list.data?.snapshots || [];
  $("backup-list").textContent = snaps.length
    ? snaps.map((s) => `${s.name}  ${fmtSize(s.size)}`).join("\n")
    : "None yet.";
  const bl = logs.data?.logs || [];
  const el = $("backup-logs");
  el.textContent = bl.length ? bl.map((l) => `${l.ts.slice(11, 19)}  ${l.line}`).join("\n") : "No logs yet.";
  el.scrollTop = el.scrollHeight;
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
  setMsg("oblogin-msg", "Login failed: " + JSON.stringify(data?.error || "unknown"), "err");
};

$("vault-enc").onchange = () => show("enc-pw-wrap", $("vault-enc").value === "end-to-end");

$("vault-refresh").onclick = async () => {
  const vaults = await api("/api/obsidian/vaults");
  const list = normalizeVaults(vaults.data);
  if (list) populateVaults(list);
  else setMsg("vault-msg", "Could not list vaults.", "err");
};

$("vault-link-btn").onclick = async () => {
  const vault = $("vault-select").value;
  const encryption = $("vault-enc").value;
  const password = $("vault-encpw").value;
  if (!vault) return setMsg("vault-msg", "Pick a vault.", "err");
  setMsg("vault-msg", "Linking…");
  const { data } = await api("/api/obsidian/setup", { method: "POST", body: { vault, encryption, password } });
  if (data?.ok) return refresh();
  setMsg("vault-msg", "Setup failed: " + JSON.stringify(data?.error || "unknown"), "err");
};

$("sync-start").onclick = async () => { await api("/api/sync/start", { method: "POST" }); refresh(); };
$("sync-stop").onclick = async () => { await api("/api/sync/stop", { method: "POST" }); refresh(); };
$("sync-refresh").onclick = () => refresh();

$("set-save").onclick = async () => {
  const { data } = await api("/api/settings", { method: "POST", body: { deviceName: $("set-device").value } });
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

$("gui-logout").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  refresh();
};

refresh();
