# Third-party software notice

## obsidian-headless (`ob`)

This project drives Obsidian's **official headless Sync client**, published on npm
as [`obsidian-headless`](https://www.npmjs.com/package/obsidian-headless)
(repository: <https://github.com/obsidianmd/obsidian-headless>).

At the time of writing that package is published as **`UNLICENSED`** — it is
proprietary Obsidian software, all rights reserved. Therefore:

- **This project does not bundle or redistribute `obsidian-headless`.** The
  container installs it from the official npm registry at runtime
  (`docker-entrypoint.sh`), into the persistent config volume. Only this
  project's own (MIT-licensed) code is distributed in the image.
- Using it requires an **active Obsidian Sync subscription** and acceptance of
  Obsidian's Terms of Service.
- This is an independent, unofficial project. It is not affiliated with,
  endorsed by, or supported by Obsidian / Dynalist Inc.

"Obsidian" is a trademark of its respective owner. The purple/dark color scheme
of the web UI is an homage and carries no endorsement.
