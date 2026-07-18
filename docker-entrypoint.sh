#!/bin/sh
set -e

# The official Obsidian headless client (`ob`) is proprietary and NOT bundled in
# this image. We install it from the official npm registry into the persistent
# config volume on first start, so we never redistribute Obsidian's code.
export NPM_CONFIG_PREFIX="${CONFIG_DIR:-/config}/npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
mkdir -p "$NPM_CONFIG_PREFIX"

if ! command -v ob >/dev/null 2>&1; then
  echo '{"level":"info","msg":"installing obsidian-headless from npm (first run)"}'
  # Install in the background so the web UI comes up immediately; the UI polls
  # and shows an "installing" notice until `ob` is ready.
  (
    if npm install -g obsidian-headless >/tmp/ob-install.log 2>&1; then
      echo '{"level":"info","msg":"obsidian-headless installed"}'
    else
      echo '{"level":"error","msg":"obsidian-headless install failed, see /tmp/ob-install.log"}'
    fi
  ) &
fi

exec node src/server.js
