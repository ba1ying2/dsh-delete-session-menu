/**
 * dsh-session-delete — host half.
 *
 * The stock sidebar can pin, rename, fork and archive a conversation, but the
 * durable session log has no deletion seam ("logs accumulate until removed
 * externally"). This plugin adds the missing piece:
 *
 *   POST /session-delete/exec   { "sessionId": "session-…" }
 *
 * It deletes `<DSH_HOME>/sessions/<project>/session-<id>/` in every project
 * directory, drops the id from the workspace registry accounting plus the
 * global pin/archive sets, detaches a live session so the in-memory store can
 * not rewrite a file it just lost, and emits `api-session/removed` so every
 * connected client drops the row.
 *
 * Admission is the same Connection policy every first-party route uses: a
 * request that `ctx.connection.requestRejection()` rejects never reaches the
 * filesystem.
 */
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-session-delete'

/** Services required before the route can be registered. */
export const inject = ['webServer', 'sessions', 'connection', 'workspaceRegistry']

/** One accepted session id shape; the id is used as a directory name. */
const SESSION_ID = /^session-[A-Za-z0-9._-]+$/

/** Route path, shared with the client half and the docs. */
const ROUTE = '/session-delete/exec'

/** JSON response helper with a no-store cache policy. */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

/** Read and parse a bounded JSON request body. */
async function readJson(req, limit = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** The session persistence root, resolved without assuming a hard-coded home. */
function sessionsRoot(ctx) {
  try {
    const home = ctx.get('homePaths')?.home
    if (typeof home === 'string' && home !== '') return join(home, 'sessions')
  } catch {
    /* service absent — fall through to the environment */
  }
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'sessions')
  return join(homedir(), '.dsh', 'sessions')
}

/**
 * Remove every `<root>/<project>/session-<id>` directory. The persistence
 * backend escapes session ids injectively; alphanumerics plus `-`, `_` and `.`
 * survive unchanged, so the id is its own directory name in practice, and all
 * spellings are tried for safety.
 */
async function removeSessionDirs(root, sessionId) {
  const bare = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId
  const names = new Set([sessionId, `session-${bare}`, bare])
  const removed = []
  const emptied = []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed, emptied }
    throw error
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const candidate of names) {
      const dir = join(projectDir, candidate)
      let info
      try {
        info = await stat(dir)
      } catch {
        continue
      }
      if (!info.isDirectory()) continue
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      removed.push(dir)
      try {
        await rmdir(projectDir)
        emptied.push(projectDir)
      } catch {
        /* the project directory still holds other sessions */
      }
      break
    }
  }
  return { removed, emptied }
}

/** Drop the id from workspace accounting, then from the pin/archive sets. */
async function detachFromRegistry(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  const detachedFrom = []
  if (registry !== undefined && registry !== null) {
    let workspaces = []
    try {
      workspaces = registry.list()
    } catch {
      workspaces = []
    }
    for (const workspace of workspaces) {
      try {
        // Idempotent: `detachSession` writes nothing when the id is absent.
        await workspace.detachSession(sessionId)
        detachedFrom.push(workspace.id ?? 'workspace')
      } catch (error) {
        ctx.logger?.warn?.(`session-delete: detaching "${sessionId}" from workspace failed: ${String(error)}`)
      }
    }
    try {
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`session-delete: unarchiving "${sessionId}" failed: ${String(error)}`)
    }
    try {
      await registry.unpinSession(sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`session-delete: unpinning "${sessionId}" failed: ${String(error)}`)
    }
  }
  return detachedFrom
}

/**
 * Detach a live session before its files disappear. The store's public entry
 * point is `liveEntryFor`, and the entry's own `detach` is the teardown
 * `enter()` handed the owner; it removes the store row and emits
 * `session/disposed`, which the session controller forwards to clients as
 * `api-session/removed`.
 */
function detachLive(ctx, sessionId) {
  const store = ctx.get('sessions')
  const session = store?.get?.(sessionId)
  if (session === undefined) return false
  try {
    const entry = store.liveEntryFor(session)
    if (typeof entry?.detach === 'function') {
      entry.detach()
      return true
    }
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: detaching live session "${sessionId}" failed: ${String(error)}`)
  }
  return false
}

/** Full deletion pipeline for one id. */
async function deleteSession(ctx, sessionId) {
  const root = sessionsRoot(ctx)
  const live = ctx.get('sessions')?.get?.(sessionId) !== undefined
  const { removed, emptied } = await removeSessionDirs(root, sessionId)
  const detachedFrom = await detachFromRegistry(ctx, sessionId)
  const wasLive = detachLive(ctx, sessionId)
  // Cold sessions never emit `session/disposed`, so publish the removal here;
  // for live ones the controller already did, and clients treat it as idempotent.
  ctx.emit('api-session/removed', sessionId)
  return { sessionId, root, removed, emptied, detachedFrom, live, wasLive }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        send(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let payload
      try {
        payload = await readJson(req)
      } catch (error) {
        send(res, 400, { ok: false, error: `invalid JSON body: ${String(error?.message ?? error)}` })
        return
      }
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
      if (!SESSION_ID.test(sessionId)) {
        send(res, 400, { ok: false, error: 'sessionId must look like "session-<id>"' })
        return
      }
      try {
        const value = await deleteSession(ctx, sessionId)
        send(res, 200, { ok: true, value })
      } catch (error) {
        ctx.logger?.warn?.(`session-delete: deleting "${sessionId}" failed: ${String(error)}`)
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-session-delete: delete route')

  ctx.logger?.info?.(`dsh-session-delete: POST ${ROUTE} ready (root ${sessionsRoot(ctx)})`)
}
