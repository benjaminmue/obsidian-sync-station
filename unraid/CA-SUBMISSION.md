# Submitting to Unraid Community Applications (CA)

The template in this folder is CA-ready. Getting it into the CA store is a
one-time, manual step (CA is moderated — it can't be done purely from code).

## What's already done

- Public GitHub repo with the image on GHCR (`ghcr.io/benjaminmue/obsidian-sync-station`).
- `ca_profile.xml` at the repo root (required `<Profile>` + Icon/WebPage/Forum).
- Valid CA template: `templates/obsidian-sync-station.xml` (Name, Repository,
  Registry, Overview, Category, WebUI, Icon, TemplateURL, Support, Project, and
  Config entries for ports/paths/variables). Validated with `xmllint`.
- Square PNG icon: `unraid/obsidian-sync-station.png` (256×256), reachable via
  raw GitHub URL.

## Steps to publish

1. **Confirm the repo is public** and the raw URLs resolve (200):
   - Template: `https://raw.githubusercontent.com/benjaminmue/obsidian-sync-station/main/templates/obsidian-sync-station.xml`
   - Icon: `https://raw.githubusercontent.com/benjaminmue/obsidian-sync-station/main/unraid/obsidian-sync-station.png`
2. **Add the CA "template repository" wrapper.** CA expects a repo listing its
   templates. Either keep templates at the repo root or point CA at this folder.
   The simplest supported layout is a dedicated templates repo, but a subfolder
   works when submitted as the templates URL.
3. **Announce it** in the Unraid forums: post in the
   *Community Applications → "Add your app / repository"* support thread (or use
   the CA "Submit your repository" flow) with the repository URL. A moderator
   reviews and adds it to the CA feed.
4. After approval, the app appears in **Apps** when searching "obsidian sync".

## Before submitting — quick checklist

- [ ] Repo public, README explains what it is and the Obsidian Sync requirement.
- [ ] `NOTICE.md` present (the `ob` client is proprietary and installed at runtime, not bundled).
- [ ] Template has a real `<Icon>` URL that loads.
- [ ] `<Support>` points to GitHub issues, `<Project>` to the repo.
- [ ] Default host port is unlikely to clash (currently 8484).
- [ ] Container starts cleanly with only the required paths mapped.

## Note on trademark

This is an unofficial project. The name uses "Obsidian" descriptively; NOTICE.md
states it is not affiliated with or endorsed by Obsidian. If CA moderators
request a rename, `Vault Sync Station` is a suitable neutral fallback.
