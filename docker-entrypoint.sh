#!/bin/sh
set -e

CONFIG_DIR="${CONFIG_DIR:-/config}"
VAULT_DIR="${VAULT_DIR:-/vault}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"
MIRROR_DIR="${MIRROR_DIR:-/mirror}"

# Run as an unprivileged user so synced files are usable by other containers.
# Defaults are Unraid's nobody:users; UMASK 0002 keeps files group-writable
# (0664/0775), matching Unraid's share convention. Set PUID=0 PGID=0 to keep the
# pre-0.6 behaviour of running everything as root.
PUID="${PUID:-99}"
PGID="${PGID:-100}"
UMASK="${UMASK:-0002}"

umask "$UMASK"

# Started with `--user` already? Then we cannot switch identity, so honour the
# one Docker gave us and skip gosu.
if [ "$(id -u)" != "0" ]; then
  PUID="$(id -u)"
  PGID="$(id -g)"
  RUNAS=""
else
  RUNAS="gosu $PUID:$PGID"
fi

# `ob` and npm write into HOME; point it at the persistent volume (config.js
# uses the same path) so nothing lands in a root-owned /root. HOME has to be
# re-applied after the privilege drop as well: gosu resets it from /etc/passwd,
# and PUID has no entry there, so npm would fall back to /.npm and fail with
# EACCES. The cache is pinned explicitly for the same reason.
OB_HOME="$CONFIG_DIR/ob-home"
export HOME="$OB_HOME"
export NPM_CONFIG_PREFIX="$CONFIG_DIR/npm-global"
export NPM_CONFIG_CACHE="$CONFIG_DIR/npm-cache"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
mkdir -p "$OB_HOME" "$NPM_CONFIG_PREFIX" "$NPM_CONFIG_CACHE"

# Existing installs (<= 0.5.6) ran as root, so every synced file is root:root and
# would be unwritable once we drop privileges. Migrate ownership once per
# PUID:PGID pair; the marker keeps later starts fast on large vaults. Set
# FIX_PERMISSIONS=false to skip it entirely and chown by hand.
MARKER="$CONFIG_DIR/.permissions-$PUID-$PGID"
if [ "$(id -u)" = "0" ] && [ "$PUID:$PGID" != "0:0" ] \
   && [ "${FIX_PERMISSIONS:-true}" = "true" ] && [ ! -f "$MARKER" ]; then
  echo '{"level":"info","msg":"applying ownership '"$PUID:$PGID"' to config/vault/backup/mirror (one-time)"}'
  for dir in "$CONFIG_DIR" "$VAULT_DIR" "$BACKUP_DIR" "$MIRROR_DIR"; do
    [ -d "$dir" ] || continue
    chown -R "$PUID:$PGID" "$dir" 2>/dev/null \
      || echo '{"level":"warn","msg":"could not chown '"$dir"', check the host permissions"}'
    # chown alone is not enough: data written by <= 0.5.6 is 0644/0755, so a
    # sibling container in the same group would still only get read access.
    # Deliberately not applied to CONFIG_DIR, where settings.json holds the GUI
    # password hash, cookie secret and backup credentials at 0600.
    case "$dir" in
      "$CONFIG_DIR") ;;
      *) chmod -R g+w "$dir" 2>/dev/null || true ;;
    esac
  done
  touch "$MARKER" 2>/dev/null || true
fi

# The official Obsidian headless client (`ob`) is proprietary and NOT bundled in
# this image. We install it from the official npm registry into the persistent
# config volume on first start, so we never redistribute Obsidian's code.
if ! command -v ob >/dev/null 2>&1; then
  echo '{"level":"info","msg":"installing obsidian-headless from npm (first run)"}'
  # Install in the background so the web UI comes up immediately; the UI polls
  # and shows an "installing" notice until `ob` is ready. Runs as the target
  # user, otherwise the install itself would recreate root-owned files.
  (
    if $RUNAS env HOME="$OB_HOME" npm install -g obsidian-headless >/tmp/ob-install.log 2>&1; then
      echo '{"level":"info","msg":"obsidian-headless installed"}'
    else
      echo '{"level":"error","msg":"obsidian-headless install failed, see /tmp/ob-install.log"}'
    fi
  ) &
fi

# Word splitting on $RUNAS is intentional: it is either empty or "gosu uid:gid".
# shellcheck disable=SC2086
exec $RUNAS env HOME="$OB_HOME" node src/server.js
