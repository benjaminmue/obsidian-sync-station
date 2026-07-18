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

const VIEWS = ["view-setup", "view-login", "view-noob", "view-oblogin", "view-vault", "view-dash", "view-settings"];
function only(...ids) {
  for (const v of VIEWS) show(v, ids.includes(v));
}

let logTimer = null;

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

  // Linked → dashboard + settings.
  only("view-dash", "view-settings");
  $("dash-vault").textContent = st.vaultName || "—";
  $("dash-device").textContent = st.deviceName || "—";
  $("dash-enc").textContent = st.encryption || "—";
  $("set-device").value = st.deviceName || "";
  updateSyncBadge(st.syncRunning);
  loadLogs();
  if (!logTimer) logTimer = setInterval(loadLogs, 5000);
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

$("gui-logout").onclick = async () => {
  await api("/api/logout", { method: "POST" });
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  refresh();
};

refresh();
