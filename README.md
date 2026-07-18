# Obsidian Sync Station

> 🤖 **Built with AI — disclosed openly.** This project is developed with heavy
> assistance from AI (Anthropic's Claude, via Claude Code): code, tests, and
> documentation. This is stated up front, not hidden. It's used for a personal
> homelab; review the code yourself before trusting it with your data, and treat
> it accordingly. Issues and PRs are welcome.

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

## Features

- Official, headless Obsidian Sync — no LiveSync/CouchDB, no VNC/GUI container.
- Web UI (Obsidian-style dark/purple), **LAN-only**, gated by its own password.
- Obsidian login (email / password / MFA), vault picker, optional end-to-end
  decryption password.
- **Two sync modes**: continuous (live, ~30s) or every N minutes — supervised
  with auto-restart, live status and log tail.
- **Local backups** (`BACKUP=true`): scheduled `tar.gz` snapshots with retention,
  run-now, and a snapshot list.
- **Off-box mirror** (`MIRROR=true`): copy each snapshot to a second volume.
- **Encrypted off-site backups via restic** (local path or cloud: S3/B2/SFTP).
- **Restore** a snapshot to a safe staging area or over the live vault.
- **ntfy notifications** on backup/sync events.
- **Unraid** Community Applications template + prebuilt multi-arch image on GHCR.

The only thing not automated is listing it in the Unraid CA *store* (a manual,
moderated forum step — see [`unraid/CA-SUBMISSION.md`](unraid/CA-SUBMISSION.md)).

## Install on Unraid

A Community Applications template lives in [`templates/obsidian-sync-station.xml`](templates/obsidian-sync-station.xml).

Until it is submitted to the CA store, add it manually:

1. Docker tab → **Add Container** → in *Template* paste:
   `https://raw.githubusercontent.com/benjaminmue/obsidian-sync-station/main/templates/obsidian-sync-station.xml`
2. Adjust the paths (`/vault` should be its own dedicated share), set **Enable Backup**
   if you want backups (and map `/backup`), then **Apply**.
3. Open the WebUI, set an access password, log in to Obsidian, pick your vault.

The image is published to GHCR: `ghcr.io/benjaminmue/obsidian-sync-station:latest`.

## Sync mode

In the Sync card you can choose how syncing runs:

- **Continuous** (default) — Obsidian's own live watcher (`ob sync --continuous`),
  which polls roughly every 30 seconds.
- **Every N minutes** — the station runs a one-shot `ob sync` on a timer instead
  (set the interval, e.g. 5 minutes). Lighter, for people who don't need
  near-realtime sync.

Changing the mode re-applies immediately if sync is currently running.

## Backups

Set `BACKUP=true` and map a `/backup` volume to your storage. A "Backup" card
appears in the UI where you set the cron schedule (default `0 3 * * *`) and how
many snapshots to keep. Snapshots are `tar.gz` archives of the vault contents;
older ones beyond the retention count are pruned automatically.

### Mirror (off-box copy)

Set `MIRROR=true` and map a `/mirror` volume (a different disk or a remote share
mounted on the host) to copy every new snapshot there as well, pruned by the same
retention. For encrypted or cloud off-site copies, see [restic](#off-site-backup-restic).

### Restore

Each snapshot in the UI has two restore actions:

- **To staging** — extracts into `/config/restores/<snapshot>/` for inspection.
  Safe; never touches the live vault.
- **To vault** — extracts over the live vault. Destructive: sync is stopped and
  left stopped. When you restart sync, the restored state is pushed to Obsidian's
  remote and may overwrite newer changes. Requires an explicit confirmation.

### Off-site backup (restic)

Set `RESTIC_REPOSITORY` and `RESTIC_PASSWORD` to also back the vault up to an
encrypted [restic](https://restic.net) repository — a local path, or cloud
storage (S3, Backblaze B2, SFTP, …) via the usual restic backend env vars. It
runs automatically after each local backup and keeps the newest N snapshots
(same retention). A "Off-site backup (restic)" card in the UI shows status,
snapshots, a run-now button, and restore-to-staging. The restic repo is
encrypted independently of the vault's own encryption.

### Notifications

Set an ntfy topic URL (`NTFY_URL` or in the UI) to get push notifications on
successful backups and on backup/sync failures. Toggle each event in Settings.
Public topics need no token; for an **auth-protected** ntfy server set an access
token (`NTFY_TOKEN` or the masked field in the UI) — it's sent as a Bearer token.

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
| `/backup` | Snapshot target (only when `BACKUP=true`) |
| `/mirror` | Second snapshot target (only when `MIRROR=true`) |

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `BACKUP` | `false` | Enable backups + backup options in the UI |
| `MIRROR` | `false` | Also copy each snapshot to a second `/mirror` volume |
| `RESTIC_REPOSITORY` | — | Enable encrypted off-site backups via restic (local path or cloud) |
| `RESTIC_PASSWORD` | — | Encryption password for the restic repository |
| `NTFY_URL` | — | Optional ntfy topic URL for push notifications (also settable in UI) |
| `NTFY_TOKEN` | — | Optional ntfy access token (Bearer) for auth-protected servers (also settable in UI) |
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
