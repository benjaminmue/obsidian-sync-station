# Obsidian Sync Station

A small Docker container with a web UI that keeps an Obsidian vault synced using
**Obsidian's official headless Sync client** — no LiveSync/CouchDB, no VNC/GUI
container, no third-party sync protocol. Built for Unraid, runs anywhere Docker
does.

> Independent, unofficial project. Not affiliated with Obsidian. Requires an
> active Obsidian Sync subscription. See [NOTICE.md](NOTICE.md).

## Why

Obsidian Sync is proprietary: no self-hosted server, no REST API. In February
2026 Obsidian shipped an official headless client
([`obsidian-headless`](https://github.com/obsidianmd/obsidian-headless), the `ob`
CLI) that runs the real sync from the command line. This project wraps it in a
configurable web UI and packages it for a server, so a vault stays continuously
synced and (optionally) backed up on your own hardware.

## Features (Milestone 1)

- Web UI in an Obsidian-style dark/purple theme.
- Obsidian login (email / password / MFA), remote vault selection, optional
  end-to-end decryption password.
- Continuous, supervised sync with live status and log tail.
- LAN-only access, gated by its own password.

Planned: local backups to your server storage (`BACKUP=true`, Milestone 2) and an
Unraid Community Applications template (Milestone 3).

## Run it (local / any Docker host)

```bash
docker compose up --build
```

Then open <http://localhost:8080>, set an access password, log in to Obsidian,
pick your vault, and start syncing.

### Volumes

| Container path | Purpose |
|---|---|
| `/config` | Persistent state: settings, GUI password hash, `ob` login + install |
| `/vault`  | The synced vault files (map to a dedicated share) |
| `/backup` | Snapshot target (only when `BACKUP=true`, Milestone 2) |

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `BACKUP` | `false` | Enable backups + backup options in the UI |
| `WEBUI_PORT` | `8080` | Web UI port |
| `DEVICE_NAME` | `obsidian-sync-station` | Label in Obsidian Sync history |

## Important

- **Never** run the Obsidian desktop app against the same vault path at the same
  time — the official client warns this causes conflicts. Give the container its
  own dedicated path.
- With **end-to-end encryption**, `ob` decrypts locally and writes **plaintext**
  to `/vault` (and therefore to backups). Choose your storage accordingly.
- Do not expose the web UI to the internet. It holds your Obsidian credentials.

## How the proprietary client is handled

`obsidian-headless` is proprietary (published `UNLICENSED`). This image does not
bundle it. The container installs it from the official npm registry on first
start, into the `/config` volume. Only this project's own MIT-licensed code is
distributed. See [NOTICE.md](NOTICE.md).

## License

MIT (this project's code only). See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
