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
# would be unwritable once we drop privileges. The first start migrates the whole
# tree and records a marker, so later starts stay fast on large vaults.
#
# The marker alone is not enough, though: anything written as root AFTER that
# migration (a rollback to an older image, a host-side `cp` or `tar x`, a
# neighbouring container running as root on the same share) stays unwritable
# forever, and `ob` aborts the ENTIRE sync run on a single EACCES. So every start
# also probes for such drift, which costs one find that stops at the first stray
# entry. Set FIX_PERMISSIONS=false to skip both and repair ownership by hand (the
# README carries the one-liner).
MARKER="$CONFIG_DIR/.permissions-$PUID-$PGID"

# The volumes we own, as positional parameters so paths stay quoted. The script
# takes no arguments of its own, the exec below is fully spelled out.
set -- "$CONFIG_DIR" "$VAULT_DIR" "$BACKUP_DIR" "$MIRROR_DIR"

# Cheap probe: print the first entry not owned by PUID, then stop walking. Our own
# markers are skipped, otherwise one of them would be the first hit on every
# install whose 0.6.0 marker ended up root-owned, and the message would name a
# piece of bookkeeping instead of the file that actually blocks syncing. A repair
# started by a real file still corrects them along the way. The exclusion is bound
# to CONFIG_DIR, which only we write; a vault file of the same name stays visible.
find_drift() {
  for dir in "$@"; do
    [ -d "$dir" ] || continue
    if [ "$dir" = "$CONFIG_DIR" ]; then
      first="$(find "$dir" ! -user "$PUID" ! -path "$CONFIG_DIR/.permissions-*" -print -quit 2>/dev/null)"
    else
      first="$(find "$dir" ! -user "$PUID" -print -quit 2>/dev/null)"
    fi
    if [ -n "$first" ]; then
      echo "$first"
      return 0
    fi
  done
  return 1
}

if [ "$(id -u)" = "0" ] && [ "$PUID:$PGID" != "0:0" ] \
   && [ "${FIX_PERMISSIONS:-true}" = "true" ]; then
  if [ ! -f "$MARKER" ]; then
    echo '{"level":"info","msg":"applying ownership '"$PUID:$PGID"' to config/vault/backup/mirror (one-time)"}'
    for dir in "$@"; do
      [ -d "$dir" ] || continue
      chown -R "$PUID:$PGID" "$dir" 2>/dev/null \
        || echo '{"level":"warn","msg":"could not chown '"$dir"', check the host permissions"}'
      # Ownership alone is not enough: data written by <= 0.5.6 is 0644/0755, so a
      # sibling container in the same group would still only get read access.
      # Skipped for CONFIG_DIR, where settings.json holds the GUI password hash,
      # the cookie secret and the backup credentials at 0600. Restricted to
      # group-readable entries so private 0700 trees (a restic repository, for
      # example) are not widened either.
      [ "$dir" = "$CONFIG_DIR" ] && continue
      find "$dir" -perm -g=r -exec chmod g+w {} + 2>/dev/null || true
    done
    if touch "$MARKER" 2>/dev/null; then
      chown "$PUID:$PGID" "$MARKER" 2>/dev/null \
        || echo '{"level":"warn","msg":"could not chown the permissions marker, it stays root-owned"}'
    fi
  else
    # The recurring probe is narrower than the one-time migration: a mapped but
    # disabled backup or mirror share holds no data this container manages, so it
    # is neither scanned nor rewritten on every start.
    set -- "$CONFIG_DIR" "$VAULT_DIR"
    if [ "${BACKUP:-false}" = "true" ]; then set -- "$@" "$BACKUP_DIR"; fi
    if [ "${MIRROR:-false}" = "true" ]; then set -- "$@" "$MIRROR_DIR"; fi
    if stray="$(find_drift "$@")"; then
      # Repair the stray entries only, not the whole tree: a full pass would be
      # slow on a large vault and would re-widen permissions an operator has
      # tightened since.
      echo '{"level":"warn","msg":"found entries not owned by '"$PUID:$PGID"' (first: '"$stray"'), repairing ownership"}'
      for dir in "$@"; do
        [ -d "$dir" ] || continue
        # chmod first, while the stray entries are still identifiable by owner.
        # Same group-readable restriction as above, and never inside CONFIG_DIR.
        if [ "$dir" != "$CONFIG_DIR" ]; then
          find "$dir" ! -user "$PUID" -perm -g=r -exec chmod g+w {} + 2>/dev/null || true
        fi
        find "$dir" ! -user "$PUID" -exec chown "$PUID:$PGID" {} + 2>/dev/null \
          || echo '{"level":"warn","msg":"could not chown '"$dir"', check the host permissions"}'
      done
    fi
  fi
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
