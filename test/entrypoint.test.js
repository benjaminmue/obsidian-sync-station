// Tests for docker-entrypoint.sh: the privilege drop and the one-time ownership
// migration that fixes root-owned vaults left behind by <= 0.5.6.
//
// The script is run with a stubbed PATH, so `id`, `gosu`, `chown`, `chmod`,
// `npm` and `node` only record their arguments instead of touching the host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = fileURLToPath(new URL("../docker-entrypoint.sh", import.meta.url));

// Build a sandbox: stub binaries that append their argv to a trace file, plus
// empty config/vault/backup/mirror directories.
function sandbox({ uid = "0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oss-entrypoint-"));
  const bin = join(root, "bin");
  const trace = join(root, "trace.log");
  mkdirSync(bin);
  for (const dir of ["config", "vault", "backup", "mirror"]) mkdirSync(join(root, dir));

  const stub = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  };
  // `id -u` decides whether we are root; `id -g` is only read in the non-root path.
  stub("id", `case "$1" in -u) echo ${uid} ;; -g) echo 1000 ;; esac`);
  // `env` is stubbed too, so a gosu-wrapped call is recorded as one line.
  for (const name of ["gosu", "chown", "chmod", "npm", "node", "env"]) {
    stub(name, `echo "${name} $*" >> "${trace}"\nexit 0`);
  }
  // `ob` must be absent so the npm install path is exercised.
  return { root, bin, trace };
}

function run(sb, env = {}) {
  execFileSync("sh", [ENTRYPOINT], {
    env: {
      PATH: `${sb.bin}:/usr/bin:/bin`,
      CONFIG_DIR: join(sb.root, "config"),
      VAULT_DIR: join(sb.root, "vault"),
      BACKUP_DIR: join(sb.root, "backup"),
      MIRROR_DIR: join(sb.root, "mirror"),
      ...env,
    },
    encoding: "utf8",
    timeout: 20000,
  });
  return existsSync(sb.trace) ? readFileSync(sb.trace, "utf8") : "";
}

test("drops privileges to PUID:PGID before starting the server", () => {
  const sb = sandbox();
  const trace = run(sb);
  assert.match(trace, /gosu 99:100 env HOME=\S+ node src\/server\.js/);
});

test("PUID/PGID are configurable", () => {
  const sb = sandbox();
  const trace = run(sb, { PUID: "1000", PGID: "1000" });
  assert.match(trace, /gosu 1000:1000 env HOME=\S+ node/);
  assert.match(trace, /chown -R 1000:1000/);
});

test("migrates ownership of vault, backup and mirror", () => {
  const sb = sandbox();
  const trace = run(sb);
  for (const dir of ["vault", "backup", "mirror"]) {
    assert.match(trace, new RegExp(`chown -R 99:100 \\S*/${dir}`), `chown missing for ${dir}`);
    assert.match(trace, new RegExp(`chmod g\\+w \\S*/${dir}`), `chmod missing for ${dir}`);
  }
});

test("chowns config but never widens its permissions (settings.json is 0600)", () => {
  const sb = sandbox();
  const trace = run(sb);
  assert.match(trace, /chown -R 99:100 \S*\/config/);
  assert.doesNotMatch(trace, /chmod g\+w \S*\/config(\s|$)/);
});

test("leaves private 0700 trees alone (a restic repo must not become group-readable)", () => {
  const sb = sandbox();
  const priv = join(sb.root, "backup", "restic");
  mkdirSync(priv, { mode: 0o700 });
  chmodSync(priv, 0o700); // mkdir mode is umask-dependent, force it
  const trace = run(sb);
  assert.match(trace, /chmod g\+w \S*\/backup/); // the backup dir itself is touched
  assert.doesNotMatch(trace, /chmod g\+w [^\n]*\/restic/);
});

test("migration runs once, then a tree without drift keeps later starts fast", () => {
  // PUID is the uid that actually owns the sandbox, so the drift probe finds
  // nothing and the second start must not touch ownership at all.
  const uid = String(process.getuid());
  const gid = String(process.getgid());
  const sb = sandbox();
  run(sb, { PUID: uid, PGID: gid });
  assert.ok(existsSync(join(sb.root, "config", `.permissions-${uid}-${gid}`)), "marker not written");
  writeFileSync(sb.trace, "");
  const second = run(sb, { PUID: uid, PGID: gid });
  assert.doesNotMatch(second, /chown/);
  assert.doesNotMatch(second, /chmod/);
  assert.match(second, new RegExp(`gosu ${uid}:${gid} env HOME=\\S+ node`));
});

test("repairs ownership that drifted in after the migration", () => {
  // The marker is present, but the tree is not owned by PUID (as happens after a
  // rollback to a root-era image or a host-side copy). `ob` aborts the entire
  // sync run on one such file, so the drift has to be repaired despite the marker.
  const sb = sandbox();
  writeFileSync(join(sb.root, "config", ".permissions-99-100"), "");
  const trace = run(sb);
  // Targeted repair, not a second full pass: no -R, and scoped by owner.
  assert.match(trace, /chown 99:100 \S*\/vault/);
  assert.doesNotMatch(trace, /chown -R/);
});

test("drift repair never widens permissions inside config", () => {
  // settings.json holds the GUI password hash and the ntfy token at 0600.
  const sb = sandbox();
  writeFileSync(join(sb.root, "config", ".permissions-99-100"), "");
  const trace = run(sb);
  assert.match(trace, /chown 99:100 \S*\/config/);
  assert.doesNotMatch(trace, /chmod g\+w \S*\/config/);
});

test("drift repair leaves private 0700 trees alone", () => {
  const sb = sandbox();
  writeFileSync(join(sb.root, "config", ".permissions-99-100"), "");
  const priv = join(sb.root, "backup", "restic");
  mkdirSync(priv, { mode: 0o700 });
  chmodSync(priv, 0o700);
  const trace = run(sb, { BACKUP: "true" });
  assert.match(trace, /chown 99:100 \S*\/backup/); // the volume is in scope
  assert.doesNotMatch(trace, /chmod g\+w [^\n]*\/restic/);
});

test("the drift probe skips volumes this container does not manage", () => {
  // A mapped but disabled backup or mirror share holds nothing `ob` syncs, so a
  // foreign owner there must not be scanned or rewritten on every start.
  const sb = sandbox();
  writeFileSync(join(sb.root, "config", ".permissions-99-100"), "");
  const trace = run(sb, { BACKUP: "false", MIRROR: "false" });
  assert.match(trace, /chown 99:100 \S*\/vault/);
  assert.doesNotMatch(trace, /chown \S*\/backup|chown 99:100 \S*\/backup/);
  assert.doesNotMatch(trace, /chown 99:100 \S*\/mirror/);
});

test("the drift probe covers backup and mirror when they are enabled", () => {
  const sb = sandbox();
  writeFileSync(join(sb.root, "config", ".permissions-99-100"), "");
  const trace = run(sb, { BACKUP: "true", MIRROR: "true" });
  assert.match(trace, /chown 99:100 \S*\/backup/);
  assert.match(trace, /chown 99:100 \S*\/mirror/);
});

test("FIX_PERMISSIONS=false also skips the drift repair", () => {
  const sb = sandbox();
  writeFileSync(join(sb.root, "config", ".permissions-99-100"), "");
  const trace = run(sb, { FIX_PERMISSIONS: "false" });
  assert.doesNotMatch(trace, /chown/);
  assert.match(trace, /gosu 99:100 env HOME=\S+ node/);
});

test("FIX_PERMISSIONS=false skips the migration entirely", () => {
  const sb = sandbox();
  const trace = run(sb, { FIX_PERMISSIONS: "false" });
  assert.doesNotMatch(trace, /chown/);
  assert.match(trace, /gosu 99:100 env HOME=\S+ node/);
});

test("PUID=0 PGID=0 keeps the pre-0.6 root behaviour without touching ownership", () => {
  const sb = sandbox();
  const trace = run(sb, { PUID: "0", PGID: "0" });
  assert.doesNotMatch(trace, /chown/);
  assert.doesNotMatch(trace, /chmod/);
  assert.match(trace, /gosu 0:0 env HOME=\S+ node/);
});

test("honours an externally supplied --user instead of calling gosu", () => {
  const sb = sandbox({ uid: "1000" });
  const trace = run(sb);
  assert.doesNotMatch(trace, /gosu/);
  assert.doesNotMatch(trace, /chown/); // not root, cannot migrate
  assert.match(trace, /^env HOME=\S+ node src\/server\.js/m);
});

test("installs the ob client as the target user, not as root", () => {
  const sb = sandbox();
  const trace = run(sb);
  assert.match(trace, /gosu 99:100 env HOME=\S+ npm install -g obsidian-headless/);
});
