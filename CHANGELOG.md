# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

Milestone 3 — Unraid packaging (no image/runtime change).

### Added
- Unraid Community Applications template (`unraid/obsidian-sync-station.xml`):
  ports, `/config` `/vault` `/backup` paths, `BACKUP`/`DEVICE_NAME`/`TZ` vars,
  WebUI link. Secrets (Obsidian login, decryption password) stay out of the
  template — they are set in the web UI.
- App icon (`unraid/obsidian-sync-station.png`).
- README install-on-Unraid section.

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
