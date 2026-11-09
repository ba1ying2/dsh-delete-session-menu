# dsh-session-menu-delete

English | [中文](README.zh.md)

Adds **Delete conversation** to the DSH sidebar's per-conversation menu: it really deletes the durable session log, detaches the session from the workspace registry, and drops the row from every connected client.

DSH natively offers pin / rename / fork / archive only — session logs are append-only by design and "accumulate until removed externally". This plugin supplies the missing delete.

## Install

```sh
dsh plugin --profile <profile> add dsh-session-menu-delete
```

On DSH Desktop use **Settings → Plugins**. The package declares `dsh.bundle.patch`, so installing it writes the mount row into the composition; no manual `cordis.patch.yml` edit is needed.

## Usage

Any conversation row → hover → `…` at the row's end → **Delete conversation** → confirm. Confirming:

- removes `<DSH_HOME>/sessions/<project>/session-<id>/` (other sessions in the project are untouched)
- drops the id from the workspace registry's `sessionIds` and from the pin / archive sets
- detaches a live session from the in-memory store before the files go away, so nothing rewrites them
- emits `api-session/removed`, so every client drops the row immediately; the page then reloads

## How it works

| Half | File | Role |
| --- | --- | --- |
| host | `lib/index.js` | `POST /session-delete/exec`, admitted by `ctx.connection.requestRejection`; removes directories, detaches registry accounting, detaches a live session, emits `api-session/removed` |
| client | `client.js` | registers `sidebar.workspaces.session.menu.item` (order 500) and the `shell.overlay` confirmation dialog; posts on confirm and reloads |

`dsh.client` (`platform: web`) plus `exports["./client"]` let `dsh-client-modules` serve `client.js` as `/plugins/dsh-session-menu-delete/client.js` — no extra wiring.

### Route

```http
POST /session-delete/exec
content-type: application/json

{ "sessionId": "session-3c98f71c-5e75-4d87-8274-21fa1ce83cf8" }
```

Success:

```json
{ "ok": true, "value": { "sessionId": "…", "root": "…/.dsh/sessions", "removed": ["…"], "detachedFrom": ["…"], "live": true, "wasLive": true } }
```

Failure: `{ "ok": false, "error": "…" }` — 400 bad request, 403 admission, 405 method, 500 filesystem.

## Limits

- The id must look like `session-<id>`; it is whitelisted before being used as a path segment.
- Only the session's own directory is removed; a `<project>` directory is pruned only when it becomes empty.
- A running agent does not block deletion: the live session is detached first.
- **Deletion is permanent** — the confirmation dialog says so.
- `.dsh/storages/session_projcache` is left alone; stale entries become unreachable after the reload.

## Development

```yaml
# local mount, in the profile's cordis.patch.yml
- insert:
    - id: session-delete
      name: dsh-session-menu-delete
```

`client.js` picks up a new revision after a page refresh (`dsh-client-modules` derives the rev from file metadata).

## License

MIT
