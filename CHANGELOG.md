# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] - 2026-07-18

### Added
- **Configurable sync mode.** Choose *Continuous* (Obsidian's live
  `ob sync --continuous`, ~30s) or *Every N minutes* (a one-shot `ob sync` on a
  timer) in the Sync card. Persisted in settings; applied immediately when sync
  is running. New settings fields `sync.mode` / `sync.intervalMinutes`, exposed
  in `/api/state` and `/api/settings`.

### Changed
- Saving sync settings no longer starts sync if it was intentionally stopped
  (Codex P2). `startSync` re-arms correctly even while a one-shot interval run is
  still finishing — a stop→start or mode change is never dropped (Codex P1).

## [0.4.2] - 2026-07-18

### Added
- Footer in the web UI with links to the GitHub repo and to open a problem or
  feature request.
- GitHub issue forms (`.github/ISSUE_TEMPLATE/`): a guided **Problem/Bug report**
  (version, deployment, steps, logs, features in use) and **Feature request**.
  The footer links deep-link straight to these templates. Blank issues disabled.

## [0.4.1] - 2026-07-18

### Added
- App logo (faceted gem) in the web UI header and as the browser favicon
  (`public/logo.svg`), replacing the plain gradient placeholder.

## [0.4.0] - 2026-07-18

Milestone 5 — off-site backups (restic) + boot-noise fix.

### Added
- **Off-site backups via restic** (`RESTIC_REPOSITORY` + `RESTIC_PASSWORD`):
  encrypted backups of the vault to a local path or cloud backend (S3, B2, SFTP,
  …). Runs automatically after each local backup, prunes with `forget
  --keep-last` (same retention). New UI card: status, run-now, snapshot list,
  restore-to-staging. New API `/api/restic/{status,snapshots,run,restore,logs}`.
  Repo/credentials come only from env (never persisted). `restic` + CA certs are
  installed in the image; restic cache lives on `/config`.
- Unraid template gains `RESTIC_REPOSITORY` and masked `RESTIC_PASSWORD`.
- `unraid/CA-SUBMISSION.md`: steps + checklist to publish to Community Applications.

### Fixed
- **Boot notification noise**: a transient continuous-sync exit right after start
  (seen on the very first boot) no longer fires an error notification. Errors are
  reported only after repeated startup failures or a crash past a 20s grace
  window (`classifySyncExit`, unit-tested).

### Notes
- Planned (v0.5.0): configurable sync interval — currently `ob sync --continuous`
  polls ~every 30s; some users want e.g. every 5 min, which needs one-shot
  `ob sync` on a timer instead of `--continuous`.
- Cosmetic (deferred): the dashboard shows the vault identifier as entered; to
  map an ID to its display name we need a sample of `ob sync-list-remote` output.

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
