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
/** Only desks active within this many days are emitted (0 disables the window). */
export const DEFAULT_WINDOW_DAYS = 7
/** Hard ceiling on emitted desks so a busy day cannot crowd the 3D scene. */
export const DEFAULT_MAX_DESKS = 8
/** Upper bounds accepted for the two curation settings. */
export const MAX_WINDOW_DAYS = 3650
export const MAX_MAX_DESKS = 64
/** The office prints `profile` under a desk; keep it legible. */
export const PROFILE_LABEL_MAX = 24
/** `{ source, windowDays, maxDesks }` defaults for a plugin with no stored settings. */
export const DEFAULT_SETTINGS = Object.freeze({
  source: DEFAULT_SOURCE,
  windowDays: DEFAULT_WINDOW_DAYS,
  maxDesks: DEFAULT_MAX_DESKS,
})

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

/** Normalise a `windowDays` value, or `null` when it is not a valid day count. */
export function normaliseWindowDays(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const days = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(days) || !Number.isInteger(days)) return null
  if (days < 0 || days > MAX_WINDOW_DAYS) return null
  return days
}

/** Normalise a `maxDesks` value, or `null` when it is not a valid desk count. */
export function normaliseMaxDesks(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const max = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(max) || !Number.isInteger(max)) return null
  if (max < 1 || max > MAX_MAX_DESKS) return null
  return max
}

/** Normalise one stored entry; a bare string is the pre-settings `source` form. */
function normaliseEntry(raw) {
  if (typeof raw === 'string') {
    const source = normaliseSource(raw)
    return source === null ? {} : { source }
  }
  if (!isObject(raw)) return {}
  /** @type {{ source?: string, windowDays?: number, maxDesks?: number }} */
  const entry = {}
  const source = normaliseSource(raw.source)
  if (source !== null) entry.source = source
  const windowDays = normaliseWindowDays(raw.windowDays)
  if (windowDays !== null) entry.windowDays = windowDays
  const maxDesks = normaliseMaxDesks(raw.maxDesks)
  if (maxDesks !== null) entry.maxDesks = maxDesks
  return entry
}

/**
 * Read the persisted per-plugin settings map.
 * Tolerant by design: a missing, corrupt, hand-edited or wrongly-typed file
 * degrades to "no overrides" (defaults apply) instead of failing the list or
 * the adapter. Both the current object form and the earlier
 * `{"plugin":"dsh"}` string form are accepted.
 *
 * @returns `Record<string, { source?, windowDays?, maxDesks? }>`
 */
export async function readSettings(store) {
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
  /** @type {Record<string, object>} */
  const settings = {}
  for (const [name, value] of Object.entries(parsed)) {
    const entry = normaliseEntry(value)
    if (Object.keys(entry).length > 0) settings[name] = entry
  }
  return settings
}

/**
 * Read the source map only, for callers that just need `PluginInfo.dataSource`.
 * @returns `Record<string, 'hermes'|'dsh'>`
 */
export async function readDataSources(store) {
  const settings = await readSettings(store)
  /** @type {Record<string, string>} */
  const sources = {}
  for (const [name, entry] of Object.entries(settings)) {
    if (entry.source !== undefined) sources[name] = entry.source
  }
  return sources
}

/** Read one plugin's source; defaults to `hermes` for anything unknown. */
export async function getDataSource(store, name) {
  const settings = await getPluginSettings(store, name)
  return settings.source
}

/**
 * Read one plugin's effective settings (defaults merged over the stored entry).
 * @returns `{ source, windowDays, maxDesks }`
 */
export async function getPluginSettings(store, name) {
  const settings = await readSettings(store)
  const entry = settings[asString(name)] ?? {}
  return {
    source: entry.source ?? DEFAULT_SETTINGS.source,
    windowDays: entry.windowDays ?? DEFAULT_SETTINGS.windowDays,
    maxDesks: entry.maxDesks ?? DEFAULT_SETTINGS.maxDesks,
  }
}

/** Write the whole map atomically (temp file + rename) so readers never see a torn file. */
async function writeSettings(store, settings) {
  await mkdir(store, { recursive: true })
  const target = dataSourcesPath(store)
  const temp = join(store, `.data-sources-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/**
 * Merge one plugin's setting patch into the persisted map.
 *
 * Only the fields present in `patch` change, so a POST that sets `windowDays`
 * alone keeps the stored source and `maxDesks`. Values equal to the defaults are
 * dropped from the file, and an entry with nothing left is removed.
 *
 * @throws when a supplied value is invalid (callers map this to HTTP 400).
 * @returns the plugin's complete effective settings.
 */
export async function setPluginSettings(store, name, patch = {}) {
  const plugin = asString(name).trim()
  if (plugin === '') throw new Error('name is required')
  const settings = await readSettings(store)
  const entry = { ...(settings[plugin] ?? {}) }

  if (patch.source !== undefined && patch.source !== null) {
    const source = typeof patch.source === 'string' ? normaliseSource(patch.source) : null
    if (source === null) throw new Error('source must be "hermes" or "dsh"')
    if (source === DEFAULT_SETTINGS.source) delete entry.source
    else entry.source = source
  }
  if (patch.windowDays !== undefined && patch.windowDays !== null) {
    const windowDays = normaliseWindowDays(patch.windowDays)
    if (windowDays === null) throw new Error(`windowDays must be an integer between 0 and ${MAX_WINDOW_DAYS} (0 disables the window)`)
    if (windowDays === DEFAULT_SETTINGS.windowDays) delete entry.windowDays
    else entry.windowDays = windowDays
  }
  if (patch.maxDesks !== undefined && patch.maxDesks !== null) {
    const maxDesks = normaliseMaxDesks(patch.maxDesks)
    if (maxDesks === null) throw new Error(`maxDesks must be an integer between 1 and ${MAX_MAX_DESKS}`)
    if (maxDesks === DEFAULT_SETTINGS.maxDesks) delete entry.maxDesks
    else entry.maxDesks = maxDesks
  }

  if (Object.keys(entry).length === 0) delete settings[plugin]
  else settings[plugin] = entry
  await writeSettings(store, settings)

  return {
    source: entry.source ?? DEFAULT_SETTINGS.source,
    windowDays: entry.windowDays ?? DEFAULT_SETTINGS.windowDays,
    maxDesks: entry.maxDesks ?? DEFAULT_SETTINGS.maxDesks,
  }
}

/**
 * Persist one plugin's source only (kept for callers that do not need the
 * curation settings).
 * @returns `{ name, source }`
 */
export async function setDataSource(store, name, source) {
  const plugin = asString(name)
  const settings = await setPluginSettings(store, plugin, { source })
  return { name: plugin, source: settings.source }
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

/** Truncate one label to the office's budget, ellipsis included. */
function clampLabel(text, max = PROFILE_LABEL_MAX) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(1, max - 1))}…`
}

/** Truncate a BASE label so a ` tag` still fits inside the budget. */
function clampWithTag(base, tag, max = PROFILE_LABEL_MAX) {
  const suffix = ` ${tag}`
  const room = Math.max(1, max - suffix.length)
  const head = base.length > room ? `${base.slice(0, Math.max(1, room - 1))}…` : base
  const out = head + suffix
  return out.length > max ? out.slice(0, max) : out
}

/**
 * The shortest trailing path suffix that is unique among `group`.
 * Deterministic: it depends only on the group's paths, never on visit order.
 */
function shortestUniqueSuffix(desk, group) {
  const segments = pathSegments(desk.path)
  if (segments.length === 0) return ''
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const candidate = segments.slice(-depth).join('/')
    const unique = group.every((other) => other === desk || pathSegments(other.path).slice(-depth).join('/') !== candidate)
    if (!unique) continue
    // A suffix equal to the display label adds nothing (`x (x)`); prefer one
    // more path segment when the path has one.
    if (candidate.toLowerCase() === desk.baseLabel.toLowerCase() && depth < segments.length) continue
    return candidate
  }
  return segments.join('/')
}

/**
 * Assign the emitted `profile` label and the truthful `profile_full`.
 *
 * `profile` is the desk's base label (workspace title, else the cwd basename)
 * clamped to 24 characters. When two emitted desks would share it, each gets the
 * shortest distinguishing path suffix inside the remaining budget; if clamping
 * still collides (two long bases sharing a prefix), a deterministic `#n` tag is
 * used instead. Both steps depend only on the emitted set, so the scene is
 * stable between polls.
 */
function applyDeskLabels(desks) {
  /** @type {Map<string, any[]>} */
  const groups = new Map()
  for (const desk of desks) {
    const key = desk.baseLabel.toLowerCase()
    const bucket = groups.get(key)
    if (bucket) bucket.push(desk)
    else groups.set(key, [desk])
  }

  for (const bucket of groups.values()) {
    if (bucket.length === 1) {
      bucket[0].full = bucket[0].baseLabel
      continue
    }
    for (const desk of bucket) {
      const suffix = shortestUniqueSuffix(desk, bucket)
      desk.full = suffix === '' ? desk.baseLabel : `${desk.baseLabel} (${suffix})`
    }
  }

  for (const desk of desks) desk.profile = clampLabel(desk.full)

  // Post-pass: clamping can still collide (distinct long names, same prefix).
  /** @type {Map<string, any[]>} */
  const emitted = new Map()
  for (const desk of desks) {
    const key = desk.profile.toLowerCase()
    const bucket = emitted.get(key)
    if (bucket) bucket.push(desk)
    else emitted.set(key, [desk])
  }
  for (const bucket of emitted.values()) {
    if (bucket.length < 2) continue
    bucket.sort((left, right) => left.full.localeCompare(right.full) || left.path.localeCompare(right.path))
    bucket.forEach((desk, index) => {
      desk.profile = clampWithTag(desk.baseLabel, `#${index + 1}`)
      desk.full = `${desk.baseLabel} #${index + 1}`
    })
  }
}

/* Desks are selected by recency but emitted in a stable order so the plugin,
   which assigns desks by array index, never reshuffles the scene between polls. */
function compareDesks(left, right) {
  if (left.busy !== right.busy) return left.busy ? -1 : 1
  const leftIndex = left.workspaceIndex ?? Number.MAX_SAFE_INTEGER
  const rightIndex = right.workspaceIndex ?? Number.MAX_SAFE_INTEGER
  if (leftIndex !== rightIndex) return leftIndex - rightIndex
  return (
    left.baseLabel.localeCompare(right.baseLabel, undefined, { sensitivity: 'base' }) || left.path.localeCompare(right.path)
  )
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
   * @param options.windowDays - recency window in days; 0 disables it.
   * @param options.maxDesks - hard ceiling on emitted desks.
   * @returns `{ desks, degraded, candidates, selected }` — `desks` is the bare
   *          array the office expects, already curated, ordered and capped.
   */
  async function compute({ windowDays = DEFAULT_WINDOW_DAYS, maxDesks = DEFAULT_MAX_DESKS } = {}) {
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
    /** @type {{ baseLabel: string, path: string, members: string[], workspaceIndex: number|null }[]} */
    const desks = []
    const assigned = new Set()

    // 1. One desk per workspace, in durable registry order. A session belongs to
    //    the workspace whose path contains its cwd; sessions with no cwd at all
    //    fall back to the workspace that lists them.
    workspaces.forEach((workspace, workspaceIndex) => {
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
      if (members.length === 0) return
      desks.push({
        baseLabel: asString(workspace?.title).trim() || dirName(path) || 'workspace',
        path,
        members,
        workspaceIndex,
      })
    })

    // 2. One desk per uncovered cwd (a "pseudo-desk": a stale session cwd that no
    //    workspace owns). These are subject to the same recency window as any
    //    other desk, so an old orphan directory never occupies the scene.
    /** @type {Map<string, string[]>} */
    const uncovered = new Map()
    for (const info of infos.values()) {
      if (assigned.has(info.id)) continue
      const key = trimPath(info.cwd)
      const bucket = uncovered.get(key)
      if (bucket) bucket.push(info.id)
      else uncovered.set(key, [info.id])
    }
    for (const [path, members] of uncovered) {
      desks.push({ baseLabel: path === '' ? 'no workspace' : dirName(path), path, members, workspaceIndex: null })
    }

    // ---- statistics per candidate desk ----
    const nowMs = now()
    const windowMs = windowDays > 0 ? windowDays * 24 * 60 * 60 * 1000 : 0
    const candidates = desks.map((desk) => {
      const members = desk.members.map((id) => infos.get(id)).filter(Boolean)
      // `busy` must mean "an agent is working right now". A live entry in
      // `agents.list()` outlives its turn, so it cannot drive the typing avatar;
      // only an agent whose readable status is 'running' counts. When a
      // deployment's agents expose no status, fall back to the activity window.
      const workingAgents = members.filter((info) => workingIds.has(info.id)).length
      const recentSessions = members.filter((info) => Number(info.lastActivityMs) > 0 && nowMs - Number(info.lastActivityMs) <= ACTIVE_WINDOW_MS).length
      const activeSessions = members.filter((info) => workingIds.has(info.id) || (Number(info.lastActivityMs) > 0 && nowMs - Number(info.lastActivityMs) <= ACTIVE_WINDOW_MS)).length
      const newest = members.reduce((max, info) => Math.max(max, Number(info.lastActivityMs) || 0), 0)
      return {
        baseLabel: desk.baseLabel,
        path: desk.path,
        workspaceIndex: desk.workspaceIndex,
        openSessions: members.length,
        workingAgents,
        recentSessions,
        activeSessions,
        activeAgents: statusKnown ? workingAgents : recentSessions,
        newest,
        tokens: members.reduce((sum, info) => sum + (Number(info.tokens) || 0), 0),
        busy: statusKnown ? workingAgents > 0 : recentSessions > 0,
      }
    })

    // ---- curation ----
    // A desk earns a place only while it is busy or its newest activity is inside
    // the window (`windowDays: 0` disables the window entirely). Without this the
    // scene fills with months-old session directories; the plugin's lounge also
    // stacks idle avatars, so a crowd reads as chaos rather than as information.
    const selected = candidates.filter(
      (desk) => windowDays === 0 || desk.busy || (desk.newest > 0 && nowMs - desk.newest <= windowMs),
    )
    selected.sort(compareDesks)
    const emitted = selected.slice(0, maxDesks)
    applyDeskLabels(emitted)

    const updatedAt = new Date(nowMs).toISOString()
    const desksPayload = emitted.map((desk) => {
      const lastActivity = toEpochSeconds(desk.newest)
      return {
        profile: desk.profile,
        profile_full: desk.full,
        active_agents: desk.activeAgents,
        state: desk.busy ? 'running' : desk.openSessions > 0 ? 'idle' : 'offline',
        updated_at: updatedAt,
        online: desk.openSessions > 0,
        busy: desk.busy,
        idle_since: lastActivity,
        active_sessions: desk.activeSessions,
        open_sessions: desk.openSessions,
        tokens_total: desk.tokens,
        cost_total: 0,
        last_session_activity: lastActivity,
        data_source: 'dsh',
      }
    })

    return {
      desks: desksPayload,
      degraded: records.length === 0 && liveIds.size === 0,
      candidates: candidates.length,
      selected: selected.length,
    }
  }

  /**
   * Read the cached-or-fresh payload.
   * @returns the bare array the office consumes (never throws for a valid call;
   *          rejects with `AdapterUnavailable` when the Harness has no services).
   */
  async function state(options = {}) {
    const windowDays = normaliseWindowDays(options.windowDays) ?? DEFAULT_WINDOW_DAYS
    const maxDesks = normaliseMaxDesks(options.maxDesks) ?? DEFAULT_MAX_DESKS
    // The cache is keyed by the curation settings so two plugins (or one plugin
    // before/after a settings change) never read each other's desk set.
    const key = `${windowDays}:${maxDesks}`
    const nowMs = now()
    if (cache !== null && cache.key === key && nowMs - cache.at < ttlMs) return cache.payload
    const computed = await compute({ windowDays, maxDesks })
    cache = { key, at: nowMs, payload: computed.desks }
    return computed.desks
  }

  /** Diagnostic view for tests/tools; always recomputes. */
  async function snapshot(options = {}) {
    return compute({
      windowDays: normaliseWindowDays(options.windowDays) ?? DEFAULT_WINDOW_DAYS,
      maxDesks: normaliseMaxDesks(options.maxDesks) ?? DEFAULT_MAX_DESKS,
    })
  }

  return { state, snapshot, invalidate, TTL: ttlMs }
}
