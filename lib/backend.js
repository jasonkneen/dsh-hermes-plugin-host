/**
 * Python FastAPI sidecar manager.
 *
 * One Hermes plugin backend half runs in exactly one long-lived Python process.
 * It is started lazily on the first request, kept warm across polls, and killed
 * after `IDLE_MS` without traffic (or when the Host unloads). The transport is a
 * Unix domain socket inside a private temp directory; platforms without AF_UNIX
 * fall back to an ephemeral `127.0.0.1` port.
 *
 * The socket is reused through one keep-alive `http.Agent`, so a browser polling
 * every 5 s costs one connection instead of one socket per request.
 *
 * @module hermes-plugin-host/backend
 */
import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { constants as FS_CONSTANTS } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the sidecar script lives (this package's `lib/sidecar.py`). */
export const SIDECAR_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sidecar.py')
/** Contract: shut the Python process down after 120 s without a request. */
export const IDLE_MS = 120_000
/** How long the sidecar may take to import the plugin and bind its socket. */
const READY_TIMEOUT_MS = 60_000
/** Per-request ceiling; the office backend answers in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 3_000
/** Cap on a proxied response body. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
/** Kept for diagnostics; the tail is reported on failure. */
const MAX_STDERR_LINES = 40

const asString = (value) => (typeof value === 'string' ? value : '')

let pythonPromise = null

/**
 * Locate the Python interpreter that carries the plugin dependencies.
 * `DSH_HERMES_PYTHON` overrides; otherwise the system interpreter that ships
 * fastapi/uvicorn on macOS, then whatever `python3` resolves to on PATH.
 */
export function resolvePython() {
  if (pythonPromise) return pythonPromise
  pythonPromise = (async () => {
    const explicit = asString(process.env.DSH_HERMES_PYTHON).trim()
    if (explicit) return explicit
    for (const candidate of ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
      try {
        await access(candidate, FS_CONSTANTS.X_OK)
        return candidate
      } catch {}
    }
    return 'python3'
  })()
  return pythonPromise
}

/** Normalise a proxied sub-path: leading slash, no traversal, query preserved. */
export function normaliseProxyPath(raw) {
  let value = asString(raw).trim()
  if (value === '') value = '/'
  if (!value.startsWith('/')) value = `/${value}`
  const [pathname, ...queryParts] = value.split('?')
  const segments = pathname.split('/')
  const cleaned = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new Error('path must not contain ".." segments')
    cleaned.push(segment)
  }
  const query = queryParts.length > 0 ? `?${queryParts.join('?')}` : ''
  return `/${cleaned.join('/')}${query}`
}

function httpRequest(entry, { path, method, body, headers, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const options = {
      method,
      path,
      headers: { accept: 'application/json', ...(headers ?? {}) },
      agent: entry.agent,
      timeout: timeoutMs,
    }
    if (entry.socketPath) options.socketPath = entry.socketPath
    else {
      options.host = entry.host
      options.port = entry.port
    }
    let request
    try {
      request = http.request(options, (response) => {
        const chunks = []
        let total = 0
        response.on('data', (chunk) => {
          total += chunk.length
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('plugin backend response exceeded 16 MiB'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json
          const contentType = asString(response.headers?.['content-type'])
          if (/json/iu.test(contentType) || /^[[{]/u.test(text.trimStart())) {
            try {
              json = JSON.parse(text)
            } catch {
              json = undefined
            }
          }
          resolve({ status: response.statusCode ?? 502, headers: response.headers ?? {}, text, json, contentType })
        })
        response.on('error', reject)
      })
    } catch (error) {
      reject(error)
      return
    }
    request.on('timeout', () => {
      request.destroy(new Error(`plugin backend timed out after ${timeoutMs} ms`))
    })
    request.on('error', reject)
    if (body !== undefined && body !== null) request.write(body)
    request.end()
  })
}

/**
 * Create the backend manager for one Host activation.
 *
 * @param options.log - diagnostic sink; never receives plugin data.
 * @returns `{ request, status, stop, stopAll, dispose }`
 */
export function createBackendManager({ log = () => {}, idleMs = IDLE_MS } = {}) {
  /** @type {Map<string, any>} */
  const entries = new Map()

  const stderrTail = (entry) => entry.stderr.slice(-6).join(' | ').slice(0, 600)

  function clearIdle(entry) {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  function scheduleIdle(entry) {
    clearIdle(entry)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      log(`sidecar for ${entry.name} idle for ${idleMs} ms; stopping it`)
      void stopEntry(entry.name)
    }, idleMs)
    entry.idleTimer.unref?.()
  }

  async function teardown(entry) {
    clearIdle(entry)
    try {
      entry.agent.destroy()
    } catch {}
    const child = entry.child
    if (child && child.exitCode === null && !child.killed) {
      await new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve(undefined)
        }
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          finish()
        }, KILL_GRACE_MS)
        timer.unref?.()
        child.once('exit', () => {
          clearTimeout(timer)
          finish()
        })
        try {
          child.kill('SIGTERM')
        } catch {
          clearTimeout(timer)
          finish()
        }
      })
    }
    if (entry.tmpDir) await rm(entry.tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  async function stopEntry(name) {
    const entry = entries.get(name)
    if (!entry) return false
    entries.delete(name)
    await teardown(entry)
    return true
  }

  async function startEntry({ name, dir, apiFile }) {
    const python = await resolvePython()
    const tmpDir = await mkdtemp(join(tmpdir(), 'hph-sidecar-'))
    const socketPath = join(tmpDir, 'sock')
    const args = [SIDECAR_PATH, '--plugin-dir', dir, '--api-file', apiFile || 'plugin_api.py']
    if (socketPath.length <= 100) args.push('--socket', socketPath)

    const entry = {
      name,
      dir,
      apiFile,
      tmpDir,
      socketPath: socketPath.length <= 100 ? socketPath : null,
      host: null,
      port: null,
      stderr: [],
      child: null,
      agent: new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, timeout: 60_000 }),
      startedAt: 0,
      lastUsedAt: Date.now(),
      idleTimer: null,
    }

    // stdin stays an open pipe on purpose: the sidecar treats EOF on it as
    // "the Host died" and exits, so a Host crash cannot orphan Python children.
    const child = spawn(python, args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true,
    })
    child.stdin?.on('error', () => {})
    entry.child = child

    const ready = new Promise((resolve, reject) => {
      let settled = false
      let buffer = ''

      const finish = (error, payload) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          const tail = stderrTail(entry)
          reject(new Error(`${error}${tail ? ` [${tail}]` : ''}`))
        } else resolve(payload)
      }

      const timer = setTimeout(() => {
        finish(`plugin backend did not become ready within ${READY_TIMEOUT_MS} ms`)
        try {
          child.kill('SIGKILL')
        } catch {}
      }, READY_TIMEOUT_MS)
      timer.unref?.()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line !== '') {
            let payload
            try {
              payload = JSON.parse(line)
            } catch {
              payload = null
            }
            if (payload && payload.ready === true) finish(null, payload)
            else if (payload && payload.ready === false) finish(`plugin backend failed to start: ${asString(payload.error) || 'unknown error'}`)
          }
          newline = buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim() === '') continue
          entry.stderr.push(line.trim())
          if (entry.stderr.length > MAX_STDERR_LINES) entry.stderr.shift()
        }
      })
      child.on('error', (error) => finish(`could not start the plugin backend: ${error?.message ?? error}`))
      child.on('exit', (code, signal) => {
        const wasReady = entry.startedAt > 0
        entry.child = null
        entry.startedAt = 0
        if (!wasReady && entries.get(name) === entry) {
          finish(`plugin backend exited before becoming ready (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`)
        } else if (entries.get(name) === entry) {
          log(`sidecar for ${name} exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`)
          entries.delete(name)
          clearIdle(entry)
          try {
            entry.agent.destroy()
          } catch {}
          rm(entry.tmpDir, { recursive: true, force: true }).catch(() => {})
        }
      })
    })

    entries.set(name, entry)

    let payload
    try {
      payload = await ready
    } catch (error) {
      entries.delete(name)
      await teardown(entry)
      throw error
    }

    if (asString(payload.socket) !== '') {
      entry.socketPath = payload.socket
      entry.host = null
      entry.port = null
    } else if (Number.isFinite(Number(payload.port)) && Number(payload.port) > 0) {
      entry.socketPath = null
      entry.host = asString(payload.host) || '127.0.0.1'
      entry.port = Number(payload.port)
    } else {
      entries.delete(name)
      await teardown(entry)
      throw new Error('plugin backend reported ready without a socket or port')
    }

    entry.startedAt = Date.now()
    entry.lastUsedAt = entry.startedAt
    scheduleIdle(entry)
    log(`sidecar for ${name} ready on ${entry.socketPath ? `unix:${entry.socketPath}` : `${entry.host}:${entry.port}`}`)
    return entry
  }

  async function ensureEntry({ name, dir, apiFile }) {
    const existing = entries.get(name)
    if (existing && existing.child && existing.startedAt > 0) {
      if (existing.dir === dir && asString(existing.apiFile) === asString(apiFile)) return existing
      // The plugin was reinstalled under the same name: restart against the new copy.
      log(`plugin ${name} changed on disk; restarting its sidecar`)
      await stopEntry(name)
    }
    return startEntry({ name, dir, apiFile })
  }

  /**
   * Proxy one request to a plugin's backend, starting the sidecar if needed.
   *
   * @param name - plugin name (sidecar identity).
   * @param target.dir - absolute plugin directory.
   * @param target.apiFile - backend module filename.
   * @param target.path - sub-path, e.g. `/state`. Leading slash optional.
   * @param target.method - `GET`, `POST`, `PUT`, `DELETE`, ...
   * @param target.body - string | undefined; JSON callers pass `JSON.stringify(...)`.
   * @returns `{ status, headers, text, json, contentType }`
   */
  async function request({ name, dir, apiFile, path, method = 'GET', body, headers, timeoutMs = REQUEST_TIMEOUT_MS }) {
    const normalised = normaliseProxyPath(path)
    const entry = await ensureEntry({ name, dir, apiFile })
    entry.lastUsedAt = Date.now()
    scheduleIdle(entry)
    const origin = new URL(`http://hermes.local${normalised}`)
    const payload = body === undefined || body === null ? undefined : body
    const requestHeaders = { ...(headers ?? {}) }
    if (typeof payload === 'string' && payload !== '') {
      requestHeaders['content-type'] = requestHeaders['content-type'] ?? 'application/json'
      requestHeaders['content-length'] = String(Buffer.byteLength(payload))
    }
    const response = await httpRequest(entry, {
      path: `${origin.pathname}${origin.search}`,
      method,
      body: payload,
      headers: requestHeaders,
      timeoutMs,
    })
    entry.lastUsedAt = Date.now()
    return response
  }

  /** Diagnostic snapshot for `api/health`; never includes plugin data. */
  function status() {
    const sidecars = []
    for (const entry of entries.values()) {
      sidecars.push({
        name: entry.name,
        ready: Boolean(entry.child) && entry.startedAt > 0,
        transport: entry.socketPath ? 'unix' : 'tcp',
        idleMs: Date.now() - entry.lastUsedAt,
        startedAt: entry.startedAt,
      })
    }
    return { sidecars, idleMs }
  }

  async function stopAll() {
    const names = [...entries.keys()]
    await Promise.allSettled(names.map((name) => stopEntry(name)))
    return names
  }

  function dispose() {
    // Fire-and-forget: `ctx.effect` cleanup may be synchronous.
    void stopAll()
  }

  return { request, status, stop: stopEntry, stopAll, dispose, resolvePython }
}
