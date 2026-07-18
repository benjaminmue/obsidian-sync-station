# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.2] - 2026-07-18

### Fixed
- **"Run backup now" (and other body-less POSTs) failed with 400 Bad Request.**
  The browser sends `Content-Type: application/json` even with no body; Fastify
  rejected the empty JSON body. Added a content-type parser that treats an empty
  body as `{}`, and the frontend now only sends the JSON header when there is a
  body. Affects backup run, sync start/stop, and logout.

## [0.3.1] - 2026-07-18

### Fixed
- **Obsidian login/sync failed with `unknown option '--json'`.** The real `ob`
  CLI (v0.0.x) has no `--json` flag and prints human-readable text. Reworked the
  wrapper to run commands without `--json` and treat output as text. Grounded
  every command against the actual `ob --help`.
- `sync-setup` used a non-existent `--encryption` flag. End-to-end encryption is
  selected by passing `--password`; also pass `--device-name` from settings.
- Vault selection no longer assumes a JSON list: the raw `sync-list-remote`
  output is shown and the vault name/ID is entered directly (format-agnostic).

### Changed
- Unraid template: default the WebUI **host** port to `8484` (container still
  listens on 8080), avoiding the common "port is already allocated" on 8080.

## [0.3.0] - 2026-07-18

Milestone 3 (Unraid packaging) + Milestone 4 (restore, notifications, mirror).

### Added
- **Restore**: restore any snapshot to a safe staging folder
  (`/config/restores/<snapshot>`), or directly over the live vault (destructive,
  requires confirmation; sync is stopped first). API:
  `/api/backup/restore-staging`, `/api/backup/restore-vault`.
- **ntfy notifications** (`notify.js`): optional push on successful backup and on
  backup/sync failures. Topic URL + toggles configurable in the web UI or via
  `NTFY_URL`.
- **Snapshot mirror** (`MIRROR=true`, `/mirror` volume): copies each new snapshot
  to a second destination and prunes it by the same retention. A simple,
  testable "off-box target"; full restic/cloud backends remain future work.
- Unraid Community Applications template (`unraid/obsidian-sync-station.xml`) +
  app icon; README install-on-Unraid section.
- New settings API: `GET/POST /api/settings` now also carries notify config.
- Tests for notify (mocked fetch), mirror copy+prune, restore-to-staging and
  restore-to-vault (incl. confirm + path-traversal guards).

### Changed
- Generalized nested-settings merge in `config.js` (backup + notify).
- Restoring over the live vault stops continuous sync and leaves it stopped for
  review, to avoid pushing an old state to the remote unintentionally.

## [0.2.0] - 2026-07-18

Milestone 2 — local backups.

### Added
- Backup engine: scheduled `tar.gz` vault snapshots to the mapped `/backup`
  volume, gated by `BACKUP=true`. Cron schedule + retention (keep newest N),
  configurable in the web UI.
- Backup card in the UI (shown only when enabled): schedule/retention config,
  run-now, snapshot list, backup log, status badge.
- API: `/api/backup/status`, `/api/backup/list`, `/api/backup/run`,
  `/api/backup/config`, `/api/backup/logs`.
- Unit + integration test suite (`node --test`) covering auth, `ob` JSON
  parsing, config persistence, and backup (snapshot/retention/validation).

### Changed
- Overlap-safe backups (no concurrent snapshot), invalid-cron guarded.

## [0.1.0] - 2026-07-18

Milestone 1 — sync via web UI.

### Added
- Node/Fastify backend that drives the official `obsidian-headless` (`ob`) client.
- Web UI in an Obsidian-inspired dark/purple theme:
  - First-run access-password setup and GUI sign-in (LAN-only by design).
  - Obsidian account login (email / password / MFA).
  - Remote vault selection with optional end-to-end decryption password.
  - Sync dashboard: start/stop, live status, log tail.
  - Settings: device name, sign out.
- Supervised continuous sync (`ob sync --continuous`) with auto-restart.
- Dockerfile + entrypoint that installs `obsidian-headless` from npm at runtime
  (never bundled — the package is proprietary/UNLICENSED, see NOTICE.md).
- `/api/health` endpoint and container HEALTHCHECK.
- docker-compose for local testing.

### Not yet included
- Backup engine (`BACKUP=true` toggle + snapshot options) — Milestone 2.
- Unraid Community Applications template (XML) + GHCR release CI — Milestone 3.
