# Obsidian Sync Station

A Docker container with a web UI that keeps an Obsidian vault synced through Obsidian's
official headless Sync client. Public project, distributed through the Unraid Community
Applications store, so strangers run this against their own notes.

## Stack
Node.js + Fastify, vanilla-JS frontend in `public/`, tests with `node --test`.

## What a review needs to know
- Users trust this container with their notes. Data loss beats every other class of
  finding: look hard at anything touching the sync path, file deletion or conflict
  resolution.
- Credentials for Obsidian Sync pass through this app. They belong in neither logs nor
  API responses nor error messages.
- `@fastify/static` is registered without directory listing. Enabling `list` would open a
  path-traversal surface that is closed today.
- The web UI has no authentication of its own and assumes a trusted network. Anything
  that widens its reach needs to state how access is controlled.

## Conventions
Code, comments, commit messages and user-facing strings in English. This is a public
repository with users who do not read German.
