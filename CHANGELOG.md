# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
