/**
 * Data-source adapter and the per-plugin source setting.
 *
 * A Hermes plugin's browser half calls `ctx.rest('/state')`; this Host proxies
 * that to the plugin's Python sidecar, which reads *Hermes* profiles. The adapter
 * lets the same plugin render *DeepSeek Harness* desks instead, without touching
 * the plugin: when a plugin's source is `dsh`, `GET /state` is answered here with
 * a payload shaped exactly like Hermes' own, synthesised from Harness services.
 *
 * The choice is persisted per plugin in `<store>/.data-sources.json` so it
 * survives restarts and does not depend on any browser.
 *
 * Services consumed (all optional, all behind `ctx.get`):
 *   workspaceRegistry.list()                  → Workspace[] { id, path, title, sessionIds }
 *   sessionQuery.listSessions(signal?)        → SessionRecord[] { header, live, persisted }
 *   agents.list()                             → Agent[] { id: SessionId } (live roster)
 *   sessions.get(id)                          → Session  { header, seq, ownEvents() }
 *
 * @module hermes-plugin-host/datasource
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'

/** Valid source values. */
export const SOURCES = Object.freeze(['hermes', 'dsh'])
/** Source used when nothing is stored, or when the stored file is unusable. */
export const DEFAULT_SOURCE = 'hermes'
/** Persisted alongside the install index. */
const DATA_SOURCES_FILE = '.data-sources.json'
/** Adapter payload cache, matching the office plugin's own /state TTL. */
export const ADAPTER_TTL_MS = 2_000
/** A session counts as active when its newest activity is inside this window. */
export const ACTIVE_WINDOW_MS = 90_000
/** The one path the adapter answers; every other backend path still proxies. */
export const ADAPTED_PATH = '/state'

const asString = (value) => (typeof value === 'string' ? value : '')
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Thrown when the Harness services the adapter needs are absent or failing. */
export class AdapterUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'AdapterUnavailable'
    this.status = 503
  }
}

/** Normalise a candidate source value, or `null` when it is not valid. */
export function normaliseSource(value) {
  const raw = asString(value).trim().toLowerCase()
  return SOURCES.includes(raw) ? raw : null
}

/* -------------------------------------------------------------------------- */
/* Persistence: <store>/.data-sources.json                                    */
/* -------------------------------------------------------------------------- */

function dataSourcesPath(store) {
  return join(store, DATA_SOURCES_FILE)
}

/**
 * Read the persisted source map.
 * Tolerant by design: a missing, corrupt, hand-edited or wrongly-typed file
 * degrades to "no overrides" (every plugin then reads as `hermes`) instead of
 * failing the list or the adapter.
 *
 * @returns `Record<string, 'hermes'|'dsh'>` containing only valid entries.
 */
export async function readDataSources(store) {
  let text
  try {
    text = await readFile(dataSourcesPath(store), 'utf8')
  } catch {
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!isObject(parsed)) return {}
  /** @type {Record<string, string>} */
  const sources = {}
  for (const [name, value] of Object.entries(parsed)) {
    const source = normaliseSource(value)
    if (source !== null) sources[name] = source
  }
  return sources
}

/** Read one plugin's source; defaults to `hermes` for anything unknown. */
export async function getDataSource(store, name) {
  const sources = await readDataSources(store)
  return sources[asString(name)] ?? DEFAULT_SOURCE
}

/** Write the whole map atomically (temp file + rename) so readers never see a torn file. */
async function writeDataSources(store, sources) {
  await mkdir(store, { recursive: true })
  const target = dataSourcesPath(store)
  const temp = join(store, `.data-sources-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temp, `${JSON.stringify(sources, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/**
 * Persist one plugin's source.
 * @returns `{ name, source }`
 */
export async function setDataSource(store, name, source) {
  const plugin = asString(name)
  const normalised = normaliseSource(source)
  if (normalised === null) throw new Error('source must be "hermes" or "dsh"')
  const sources = await readDataSources(store)
  if (normalised === DEFAULT_SOURCE) delete sources[plugin]
  else sources[plugin] = normalised
  await writeDataSources(store, sources)
  return { name: plugin, source: normalised }
}

/* -------------------------------------------------------------------------- */
/* Path helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Trim trailing separators (but keep a bare root) so prefix checks are stable. */
function trimPath(value) {
  const path = asString(value).trim()
  if (path === '') return ''
  const trimmed = path.length > 1 ? path.replace(/[\\/]+$/u, '') : path
  return trimmed === '' ? path : trimmed
}

/** True when `cwd` is `root` itself or lives inside it. */
function isInside(cwd, root) {
  const inner = trimPath(cwd)
  const outer = trimPath(root)
  if (inner === '' || outer === '') return false
  if (inner === outer) return true
  return inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`)
}

/** Human desk name for a directory, used when no workspace title exists. */
function dirName(path) {
  const trimmed = trimPath(path)
  if (trimmed === '') return ''
  const last = trimmed.split(/[\\/]/u).filter(Boolean).pop()
  return last ?? trimmed
}

/** Epoch milliseconds → epoch seconds with millisecond precision. */
function toEpochSeconds(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value) / 1000
}

/* -------------------------------------------------------------------------- */
/* Adapter                                                                    */
/* -------------------------------------------------------------------------- */

/** Display segments of a path, with the dot/dash prefix trimmed. */
function pathSegments(path) {
  return trimPath(path)
    .split(/[\\/]+/u)
    .filter(Boolean)
    .map((segment) => segment.replace(/^[.\-_]+/u, '') || segment)
}

/**
 * Give colliding desk names a deterministic path suffix.
 *
 * Desks are grouped by case-insensitive name; inside a group each desk gets the
 * shortest trailing path suffix that is unique within that group (e.g.
 * `model-discovery (ao-dev-data-model-discovery)`). The suffix depends only on
 * the paths in the group, never on iteration order, so the scene is stable
 * between polls. A suffix longer than `MAX_LABEL` is still used when it is the
 * only unique one — a slightly long label beats two identical desks.
 */
function disambiguateDeskNames(desks) {
  const MAX_LABEL = 56
  /** @type {Map<string, any[]>} */
  const groups = new Map()
  for (const desk of desks) {
    const key = desk.name.toLowerCase()
    const bucket = groups.get(key)
    if (bucket) bucket.push(desk)
    else groups.set(key, [desk])
  }
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue
    const segments = new Map(bucket.map((desk) => [desk, pathSegments(desk.path)]))
    for (const desk of bucket) {
      const own = segments.get(desk)
      if (own.length === 0) continue
      let chosen = ''
      let fallback = ''
      for (let depth = 1; depth <= own.length; depth += 1) {
        const candidate = own.slice(-depth).join('/')
        const unique = bucket.every((other) => {
          if (other === desk) return true
          const theirs = segments.get(other)
          return theirs.slice(-depth).join('/') !== candidate
        })
        if (!unique) continue
        if (fallback === '') fallback = candidate
        // A suffix identical to the display name adds no information
        // (`model-discovery (model-discovery)`); prefer one parent segment more
        // when the path has any, so the label actually distinguishes the desk.
        if (candidate.toLowerCase() === desk.name.toLowerCase() && depth < own.length) continue
        if (candidate.length <= MAX_LABEL) {
          chosen = candidate
          break
        }
      }
      const label = chosen || fallback || trimPath(desk.path)
      if (label !== '') desk.name = `${desk.name} (${label})`
    }
  }
}

/**
 * Create the DeepSeek-Harness → Hermes-`/state` adapter.
 *
 * @param options.getService - `(name) => ctx.get(name)`, resolved per call so
 *        late-appearing services are picked up without re-activation.
 * @param options.log - diagnostic sink.
 * @param options.ttlMs - payload cache lifetime (the office polls every 5 s).
 * @param options.now - clock injection for tests.
 * @returns `{ state, invalidate, snapshot, TTL }`
 */
export function createDshAdapter({ getService, log = () => {}, ttlMs = ADAPTER_TTL_MS, now = () => Date.now() } = {}) {
  let cache = null

  const service = (name) => {
    try {
      return getService?.(name) ?? undefined
    } catch {
      return undefined
    }
  }

  /** Drop the cached payload; called when the source setting changes. */
  function invalidate() {
    cache = null
  }

  /**
   * Build the office payload from Harness state.
   * @returns `{ desks, degraded }` — `desks` is the bare array the office expects.
   */
  async function compute() {
    const sessionQuery = service('sessionQuery')
    const agentService = service('agents')
    const workspaceRegistry = service('workspaceRegistry')
    const sessionStore = service('sessions')

    if (!sessionQuery && !agentService) {
      throw new AdapterUnavailable(
        'Harness session index not available: neither the sessionQuery nor the agents service is present, so the office cannot show Harness desks',
      )
    }

    let records = []
    if (sessionQuery && typeof sessionQuery.listSessions === 'function') {
      try {
        const listed = await sessionQuery.listSessions()
        records = Array.isArray(listed) ? listed : []
      } catch (error) {
        log(`data-source adapter could not list sessions: ${error?.message ?? error}`)
      }
    }

    let workspaces = []
    if (workspaceRegistry && typeof workspaceRegistry.list === 'function') {
      try {
        const listed = workspaceRegistry.list()
        workspaces = Array.isArray(listed) ? listed : []
      } catch (error) {
        log(`data-source adapter could not list workspaces: ${error?.message ?? error}`)
      }
    }

    /** @type {Map<string, any>} one entry per session, keyed by session id */
    const infos = new Map()
    for (const record of records) {
      const header = isObject(record) && isObject(record.header) ? record.header : null
      const id = asString(header?.id)
      if (id === '') continue
      infos.set(id, {
        id,
        cwd: asString(header?.cwd),
        createdAt: Number(header?.createdAt) || 0,
        live: record?.live === true,
        lastActivityMs: Number(header?.createdAt) || 0,
        tokens: 0,
        workspaceSession: false,
      })
    }

    // ---- live roster ----
    // The `agents` service types `Agent` as `{ readonly id: SessionId }`, but the
    // concrete runtime agent also exposes `readonly status: 'idle' | 'running'`
    // and `readonly session: Session`. Presence in `list()` only means the agent
    // object is still alive — it survives the end of its turn — so `status` is
    // the only honest "working now" signal. `statusKnown` records whether this
    // deployment's agents expose it at all, so the desk logic can fall back to
    // activity recency instead of silently reporting an idle desk as busy.
    const liveIds = new Set()
    const workingIds = new Set()
    let statusKnown = false
    if (agentService && typeof agentService.list === 'function') {
      let liveAgents = []
      try {
        const listed = agentService.list()
        liveAgents = Array.isArray(listed) ? listed : []
      } catch (error) {
        log(`data-source adapter could not list agents: ${error?.message ?? error}`)
      }
      for (const agent of liveAgents) {
        const id = asString(agent?.id)
        if (id === '') continue
        liveIds.add(id)
        if (typeof agent?.status === 'string') {
          statusKnown = true
          if (agent.status === 'running') workingIds.add(id)
        }
        const existing = infos.get(id)
        if (existing) {
          existing.live = true
          if (typeof agent?.session?.ownEvents === 'function') existing.sessionObject = agent.session
          continue
        }
        // A live session missing from the corpus listing: fall back to the
        // runtime agent's own session (then the store) for its header, so it
        // still gets a desk.
        let session = null
        try {
          session = agent?.session ?? sessionStore?.get?.(id) ?? null
        } catch {}
        const header = session?.header ?? null
        infos.set(id, {
          id,
          cwd: asString(header?.cwd),
          createdAt: Number(header?.createdAt) || 0,
          live: true,
          lastActivityMs: Number(header?.createdAt) || 0,
          tokens: 0,
          workspaceSession: false,
          sessionObject: session,
        })
      }
    }

    // Cumulative tokens and last activity exist only for LIVE sessions: the
    // harness keeps no durable per-session token aggregate, and scanning 2 GB
    // of persisted logs per poll is not acceptable. `ownEvents()` is in memory.
    for (const info of infos.values()) {
      if (!info.live) continue
      const session =
        info.sessionObject ??
        (() => {
          try {
            return sessionStore?.get?.(info.id) ?? null
          } catch {
            return null
          }
        })()
      if (!session || typeof session.ownEvents !== 'function') continue
      try {
        const events = session.ownEvents() ?? []
        let tokens = 0
        let newest = 0
        for (const event of events) {
          if (!isObject(event)) continue
          if (Number(event.time) > newest) newest = Number(event.time)
          if (event.type !== 'assistant/message') continue
          const usage = event.data?.usage
          if (!isObject(usage)) continue
          const total = Number(usage.totalTokens)
          tokens += Number.isFinite(total) && total > 0 ? total : (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0)
        }
        info.tokens = tokens
        if (newest > 0) info.lastActivityMs = Math.max(info.lastActivityMs, newest)
      } catch (error) {
        log(`data-source adapter could not fold live session ${info.id}: ${error?.message ?? error}`)
      }
    }

    // ---- desks ----
    /** @type {{ name: string, path: string, members: string[] }[]} */
    const desks = []
    const assigned = new Set()

    // 1. One desk per workspace, in durable registry order. A session belongs to
    //    the workspace whose path contains its cwd; sessions with no cwd at all
    //    fall back to the workspace that lists them.
    for (const workspace of workspaces) {
      const path = trimPath(workspace?.path)
      const members = []
      for (const info of infos.values()) {
        if (assigned.has(info.id)) continue
        if (info.cwd !== '') {
          if (isInside(info.cwd, path)) {
            members.push(info.id)
            assigned.add(info.id)
          }
          continue
        }
        const listed = Array.isArray(workspace?.sessionIds) && workspace.sessionIds.some((id) => asString(id) === info.id)
        if (listed) {
          members.push(info.id)
          assigned.add(info.id)
        }
      }
      if (members.length === 0) continue
      desks.push({ name: asString(workspace?.title).trim() || dirName(path) || 'workspace', path, members })
    }

    // 2. One desk per uncovered cwd, ordered by name so the scene is stable.
    /** @type {Map<string, string[]>} */
    const uncovered = new Map()
    for (const info of infos.values()) {
      if (assigned.has(info.id)) continue
      const key = trimPath(info.cwd)
      const bucket = uncovered.get(key)
      if (bucket) bucket.push(info.id)
      else uncovered.set(key, [info.id])
    }
    const uncoveredDesks = [...uncovered.entries()]
      .map(([path, members]) => ({ name: path === '' ? 'no workspace' : dirName(path), path, members }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) || left.path.localeCompare(right.path))
    desks.push(...uncoveredDesks)

    // ---- names ----
    // Several workspaces can share a display name (four `model-discovery` clones
    // on this machine); the office prints the name under each desk, so a repeat
    // would be an unreadable label. Disambiguate deterministically from the path.
    disambiguateDeskNames(desks)

    // ---- payload ----
    const nowMs = now()
    const updatedAt = new Date(nowMs).toISOString()
    const desksPayload = desks.map((desk) => {
      const members = desk.members.map((id) => infos.get(id)).filter(Boolean)
      const openSessions = members.length
      // `busy` must mean "an agent is working right now". A live entry in
      // `agents.list()` outlives its turn, so it cannot drive the typing avatar;
      // only an agent whose readable status is 'running' counts. When a
      // deployment's agents expose no status, fall back to the activity window.
      const workingAgents = members.filter((info) => workingIds.has(info.id)).length
      const recentSessions = members.filter((info) => Number(info.lastActivityMs) > 0 && nowMs - Number(info.lastActivityMs) <= ACTIVE_WINDOW_MS).length
      const activeSessions = members.filter((info) => workingIds.has(info.id) || (Number(info.lastActivityMs) > 0 && nowMs - Number(info.lastActivityMs) <= ACTIVE_WINDOW_MS)).length
      const activeAgents = statusKnown ? workingAgents : recentSessions
      const newest = members.reduce((max, info) => Math.max(max, Number(info.lastActivityMs) || 0), 0)
      const tokens = members.reduce((sum, info) => sum + (Number(info.tokens) || 0), 0)
      const busy = statusKnown ? workingAgents > 0 : recentSessions > 0
      const online = openSessions > 0
      const state = busy ? 'running' : openSessions > 0 ? 'idle' : 'offline'
      const lastActivity = toEpochSeconds(newest)
      return {
        profile: desk.name,
        active_agents: activeAgents,
        state,
        updated_at: updatedAt,
        online,
        busy,
        idle_since: lastActivity,
        active_sessions: activeSessions,
        open_sessions: openSessions,
        tokens_total: tokens,
        cost_total: 0,
        last_session_activity: lastActivity,
        data_source: 'dsh',
      }
    })

    return { desks: desksPayload, degraded: records.length === 0 && liveIds.size === 0 }
  }

  /**
   * Read the cached-or-fresh payload.
   * @returns the bare array the office consumes (never throws for a valid call;
   *          rejects with `AdapterUnavailable` when the Harness has no services).
   */
  async function state() {
    const nowMs = now()
    if (cache !== null && nowMs - cache.at < ttlMs) return cache.payload
    const computed = await compute()
    cache = { at: nowMs, payload: computed.desks }
    return computed.desks
  }

  /** Diagnostic view for tests/tools; always recomputes. */
  async function snapshot() {
    return compute()
  }

  return { state, snapshot, invalidate, TTL: ttlMs }
}
