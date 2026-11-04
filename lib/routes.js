/**
 * Host HTTP routes.
 *
 * Two carriers serve the same operations, both registered, because either can
 * be absent depending on the deployment:
 *
 * 1. **Primary** — `ctx.get('connection').fetch.register(...)`: authenticated,
 *    exact WHATWG Fetch routes under `/api/hermes-plugins/<op>`. This is what the
 *    browser half fetches with `credentials: 'same-origin'`.
 * 2. **Fallback** — `ctx.get('webServer').register({ kind: 'prefix', path:
 *    '/hermes-plugins' })`: raw node `(req, res)` with the same operations under
 *    `/hermes-plugins/<op>`, refusing a cross-origin `Origin` header.
 *
 * Operations (JSON in/out, `{ ok: true, … }` or `{ ok: false, error }`):
 *
 *   list      GET   — installed plugins + store + detected Hermes plugins
 *   install   POST  — `{ source, name?, overwrite? }`
 *   remove    POST  — `{ name }`
 *   source    GET   — `?name=` → `desktop/plugin.js` text
 *   module    GET   — `?name=runtime|sdk|sdk.css` → raw browser ESM/CSS
 *   health    GET   — version, store, sidecar table
 *   data-source GET/POST — read or persist a plugin's data source (`hermes`|`dsh`)
 *   backend   *     — proxy into the plugin's Python sidecar, except `GET /state`
 *                    when the plugin's source is `dsh`, which the Harness
 *                    adapter answers itself (see `lib/datasource.js`)
 *
 * `module` is the only operation whose success body is not JSON (it is the
 * JavaScript/CSS the browser half imports from a Blob URL).
 *
 * @module hermes-plugin-host/routes
 */
import { normaliseProxyPath } from './backend.js'
import { ADAPTED_PATH, DEFAULT_SOURCE, getDataSource, normaliseSource, setDataSource } from './datasource.js'
import {
  HERMES_PLUGINS_DIR,
  detectHermesPlugins,
  ensureStore,
  findPlugin,
  installPlugin,
  readBrowserModule,
  readDesktopSource,
  readIndex,
  removePlugin,
  resolveBackend,
  scanPlugins,
  webAssetsReady,
} from './registry.js'

/** Authenticated Fetch routes (Connection). */
export const FETCH_PREFIX = '/api/hermes-plugins'
/** Same-origin raw-node routes (Web carrier). */
export const FALLBACK_PREFIX = '/hermes-plugins'
/** Body ceiling for one JSON operation request. */
const MAX_BODY_BYTES = 2 * 1024 * 1024
/** Ceiling for a proxied backend request body. */
const MAX_BACKEND_BODY_BYTES = 8 * 1024 * 1024
const NO_STORE = 'no-store'

/**
 * The exact route table. Each entry becomes one `connection.fetch.register` call.
 * `methods` is limited to what Connection admits (`GET`, `HEAD`, `POST`), so the
 * backend proxy is one exact path: the target plugin and its sub-path travel in
 * the query string (GET/HEAD) or the JSON body (POST).
 */
export const FETCH_ROUTES = Object.freeze([
  { op: 'list', path: `${FETCH_PREFIX}/list`, methods: ['GET', 'HEAD'] },
  { op: 'install', path: `${FETCH_PREFIX}/install`, methods: ['POST'] },
  { op: 'remove', path: `${FETCH_PREFIX}/remove`, methods: ['POST'] },
  { op: 'source', path: `${FETCH_PREFIX}/source`, methods: ['GET', 'HEAD'] },
  { op: 'module', path: `${FETCH_PREFIX}/module`, methods: ['GET', 'HEAD'] },
  { op: 'health', path: `${FETCH_PREFIX}/health`, methods: ['GET', 'HEAD'] },
  { op: 'data-source', path: `${FETCH_PREFIX}/data-source`, methods: ['GET', 'HEAD', 'POST'] },
  { op: 'backend', path: `${FETCH_PREFIX}/backend`, methods: ['GET', 'HEAD', 'POST'] },
])

const asString = (value) => (typeof value === 'string' ? value : '')
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** An error that carries the HTTP status the route should answer with. */
export class RouteError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'RouteError'
    this.status = status
  }
}

function badRequest(message, status = 400) {
  return new RouteError(message, status)
}

/**
 * Build the operation implementations shared by both carriers.
 *
 * @param options.store - absolute store directory.
 * @param options.backend - sidecar manager from `backend.js`.
 * @param options.log - diagnostic sink.
 * @param options.version - Host plugin version reported by `health`.
 * @param options.startedAt - activation epoch ms.
 */
export function createOperations({ store, backend, adapter = null, log = () => {}, version = '0.0.0', startedAt = Date.now() }) {
  // `version` may be a getter: the package version is read asynchronously during
  // activation, and `health` must report the real one once it lands.
  const versionLabel = typeof version === 'function' ? version : () => version
  const operations = {
    /** `GET list` */
    async list() {
      await ensureStore(store)
      const [plugins, available, index, webAssets] = await Promise.all([
        scanPlugins(store),
        detectHermesPlugins(),
        readIndex(store),
        webAssetsReady(),
      ])
      return {
        ok: true,
        store,
        hermesHome: HERMES_PLUGINS_DIR.replace(/[\\/]plugins$/u, ''),
        hermesPluginsDir: HERMES_PLUGINS_DIR,
        plugins,
        available,
        indexEntries: Object.keys(index).length,
        webAssets,
      }
    },

    /** `POST install` */
    async install(params) {
      const source = asString(params.source).trim()
      if (source === '') throw badRequest('source is required (an absolute directory or a git URL)')
      if (typeof params.overwrite !== 'undefined' && typeof params.overwrite !== 'boolean') {
        throw badRequest('overwrite must be a boolean')
      }
      const name = asString(params.name).trim()
      const plugin = await installPlugin({
        store,
        source,
        name: name === '' ? undefined : name,
        overwrite: params.overwrite === true,
      })
      log(`installed hermes plugin ${plugin.name} from ${plugin.source ?? source}`)
      return { ok: true, plugin }
    },

    /** `POST remove` */
    async remove(params) {
      const name = asString(params.name).trim()
      if (name === '') throw badRequest('name is required')
      const plugin = await findPlugin(store, name)
      const removed = await removePlugin(store, name)
      if (plugin) {
        const backendState = backend?.status?.()?.sidecars ?? []
        if (backendState.some((entry) => entry.name === plugin.name)) await backend.stop(plugin.name).catch(() => {})
      }
      log(`removed hermes plugin ${removed.name}`)
      return { ok: true, name: removed.name, dir: removed.dir }
    },

    /** `GET source?name=` */
    async source(params) {
      const name = asString(params.name ?? params.plugin).trim()
      if (name === '') throw badRequest('name is required')
      const result = await readDesktopSource(store, name)
      return { ok: true, name: result.name, source: result.source, bytes: result.bytes }
    },

    /** `GET module?name=runtime|sdk|sdk.css` — the only non-JSON success body. */
    async module(params) {
      const kind = asString(params.name ?? params.module).trim()
      if (kind === '') throw badRequest('name is required (runtime, sdk or sdk.css)')
      try {
        const { text, contentType } = await readBrowserModule(kind)
        return { text, contentType, status: 200 }
      } catch (error) {
        throw new RouteError(error?.message ?? String(error), Number(error?.status) || 404)
      }
    },

    /** `GET health` */
    async health() {
      const webAssets = await webAssetsReady()
      return {
        ok: true,
        version: versionLabel(),
        store,
        uptimeMs: Date.now() - startedAt,
        webAssets,
        backend: backend?.status?.() ?? { sidecars: [], idleMs: 0 },
        python: await backend?.resolvePython?.(),
      }
    },

    /**
     * Proxy into the plugin's Python sidecar, starting it if needed.
     *
     * The carrier method is never forwarded implicitly: a POST to
     * `/api/hermes-plugins/backend` is only the JSON envelope. The plugin is
     * called with `params.method` when given, otherwise GET. The path-style
     * fallback (`/hermes-plugins/backend/<plugin>/<rest>`) sets `params.method`
     * from the actual request method, so that spelling still forwards it.
     *
     * @param params.name - installed plugin name.
     * @param params.path - sub-path inside the plugin API (e.g. `/state`).
     * @param params.method - forwarded method; defaults to GET.
     * @param params.body - object (serialised to JSON) or string.
     */
    async backend(params) {
      const name = asString(params.name ?? params.plugin).trim()
      if (name === '') throw badRequest('name is required')
      const target = await resolveBackend(store, name)
      if (!target.hasBackend) {
        throw badRequest(`plugin "${target.plugin.name}" has no backend half`, 400)
      }
      const requestedMethod = asString(params.method).trim().toUpperCase()
      const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/u.test(requestedMethod) ? requestedMethod : 'GET'
      const subPath = asString(params.path).trim()

      // ---- data-source adapter: answer /state from Harness state when asked ----
      // A per-call `source` override wins (the agent tool uses it to compare the
      // two views); otherwise the persisted per-plugin setting decides.
      let source = DEFAULT_SOURCE
      const hasSourceOverride = params.source !== undefined && params.source !== null
      if (hasSourceOverride) {
        const override = typeof params.source === 'string' ? normaliseSource(params.source) : null
        if (override === null) throw badRequest('source must be "hermes" or "dsh"')
        source = override
      } else {
        source = await getDataSource(store, target.plugin.name)
      }
      if (source === 'dsh') {
        const proxied = normaliseProxyPath(subPath === '' ? '/' : subPath)
        const pathname = proxied.split('?')[0]
        if (pathname === ADAPTED_PATH) {
          if (!adapter || typeof adapter.state !== 'function') {
            throw new RouteError('Harness session index not available: the data-source adapter is not active', 503)
          }
          let payload
          try {
            payload = await adapter.state()
          } catch (error) {
            throw new RouteError(asString(error?.message) || 'Harness data source unavailable', Number(error?.status) || 503)
          }
          return {
            raw: true,
            status: 200,
            contentType: 'application/json; charset=utf-8',
            text: JSON.stringify(payload),
          }
        }
      }

      let body
      if (method !== 'GET' && method !== 'HEAD' && params.body !== undefined && params.body !== null) {
        body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body)
      }
      const response = await backend.request({
        name: target.plugin.name,
        dir: target.pluginDir,
        apiFile: target.apiFile,
        path: subPath === '' ? '/' : subPath,
        method,
        body,
      })
      return {
        raw: true,
        status: response.status,
        contentType: asString(response.contentType) || 'application/json; charset=utf-8',
        text: response.text,
      }
    },

    /**
     * Read (`GET`) or set (`POST`) one plugin's data source.
     * `hermes` proxies `/state` to the Python sidecar; `dsh` answers it from the
     * Harness adapter. The setting is persisted in `<store>/.data-sources.json`.
     */
    async 'data-source'(params) {
      const name = asString(params.name).trim()
      if (name === '') throw badRequest('name is required')
      const plugin = await findPlugin(store, name)
      if (!plugin) throw badRequest(`plugin "${name}" is not installed`, 404)
      const requested = params.source
      if (requested === undefined || requested === null) {
        const source = await getDataSource(store, plugin.name)
        return { ok: true, name: plugin.name, source }
      }
      // Present-but-not-a-valid-source is an error, never a silent read: a
      // number/boolean/empty value from a hand-built request must not look like
      // "no source supplied".
      const normalised = typeof requested === 'string' ? normaliseSource(requested) : null
      if (normalised === null) throw badRequest('source must be "hermes" or "dsh"')
      const result = await setDataSource(store, plugin.name, normalised)
      // The office polls /state every 5 s; the cached adapter payload belongs to
      // the previous source, so drop it the moment the setting changes.
      try {
        adapter?.invalidate?.()
      } catch {}
      log(`data source for ${plugin.name} set to ${result.source}`)
      return { ok: true, name: plugin.name, source: result.source }
    },
  }

  /**
   * Run one operation.
   * @param op - one of `list|install|remove|source|module|health|backend`.
   * @param params - operation parameters.
   * @param carrierMethod - HTTP method the carrier received (informational; the
   *        backend proxy forwards `params.method` and defaults to GET).
   * @returns a JSON value, or `{ text, contentType, status }` for `module`, or
   *          `{ raw: true, status, contentType, text }` for `backend`.
   */
  async function run(op, params = {}, carrierMethod = 'GET') {
    const handler = operations[op]
    if (typeof handler !== 'function') throw badRequest(`unknown operation "${asString(op)}"`, 404)
    return handler(isObject(params) ? params : {}, carrierMethod)
  }

  return { run, operations, store }
}

/* -------------------------------------------------------------------------- */
/* WHATWG Fetch carrier (Connection)                                          */
/* -------------------------------------------------------------------------- */

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE },
  })
}

function textResponse(text, contentType, status = 200) {
  return new Response(text, {
    status,
    headers: { 'content-type': contentType, 'cache-control': NO_STORE },
  })
}

function errorResponse(error) {
  const status = Number(error?.status) || 500
  const message = asString(error?.message) || 'internal error'
  return jsonResponse({ ok: false, error: message }, status)
}

async function readJsonBody(request) {
  let text = ''
  try {
    text = await request.text()
  } catch {
    throw badRequest('could not read the request body')
  }
  if (text.trim() === '') return {}
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw badRequest('request body is too large', 413)
  try {
    const parsed = JSON.parse(text)
    return isObject(parsed) ? parsed : {}
  } catch {
    throw badRequest('expected a JSON body')
  }
}

/**
 * Build the WHATWG Fetch handler for one operation.
 * @param operations - result of `createOperations`.
 * @param op - operation name from `FETCH_ROUTES`.
 * @returns `(request: Request) => Promise<Response>`
 */
export function createFetchHandler(operations, op) {
  return async function handleFetch(request) {
    try {
      const method = asString(request.method).toUpperCase() || 'GET'
      if (method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'cache-control': NO_STORE } })
      }
      const url = new URL(request.url)
      const query = url.searchParams
      let params = {}
      if (method === 'POST') {
        const body = await readJsonBody(request)
        params = { ...body }
      } else {
        for (const [key, value] of query.entries()) params[key] = value
      }
      const result = await operations.run(op, params, method)
      if (result && typeof result === 'object' && result.raw === true) {
        return textResponse(asString(result.text), asString(result.contentType) || 'application/json; charset=utf-8', Number(result.status) || 200)
      }
      if (result && typeof result === 'object' && typeof result.text === 'string' && typeof result.contentType === 'string') {
        return textResponse(result.text, result.contentType, Number(result.status) || 200)
      }
      return jsonResponse(result)
    } catch (error) {
      return errorResponse(error)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Raw node carrier (Web)                                                     */
/* -------------------------------------------------------------------------- */

function writeJson(response, value, status = 200) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': NO_STORE,
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(body)
}

function writeText(response, text, contentType, status = 200) {
  const body = String(text ?? '')
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': NO_STORE,
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(body)
}

async function readNodeBody(request, limit) {
  let total = 0
  const chunks = []
  for await (const chunk of request) {
    total += chunk.length
    if (total > limit) throw badRequest('request body is too large', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Register the authenticated Fetch routes on the Connection service.
 *
 * @param ctx - owning Host context; every registration goes through `ctx.effect`.
 * @param options.connection - the Connection service.
 * @param options.operations - result of `createOperations`.
 * @param options.registerWithRetry - shared retrying disposer helper.
 * @returns the number of routes registered.
 */
export function registerFetchRoutes(ctx, { connection, operations, registerWithRetry, log = () => {} }) {
  if (!connection?.fetch || typeof connection.fetch.register !== 'function') return 0
  let count = 0
  for (const route of FETCH_ROUTES) {
    const handler = createFetchHandler(operations, route.op)
    ctx.effect(
      () =>
        registerWithRetry(
          () => connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: handler }),
          `the fetch route ${route.path}`,
        ),
      `hermes-plugin-host: fetch route ${route.path}`,
    )
    count += 1
  }
  if (count > 0) log(`registered ${count} authenticated fetch routes under ${FETCH_PREFIX}`)
  return count
}

/**
 * Build the raw-node handler for the same-origin fallback carrier.
 * It refuses a cross-site `Origin`, and accepts both `/hermes-plugins/<op>` and
 * the legacy `/hermes-plugins/api/<op>` spelling.
 */
export function createNodeHandler(operations, { log = () => {} } = {}) {
  return async function handleNode(request, response) {
    try {
      const origin = asString(request.headers?.origin)
      const host = asString(request.headers?.host)
      if (origin && /^https?:/iu.test(origin)) {
        let originHost = ''
        try {
          originHost = new URL(origin).host
        } catch {}
        if (!host || originHost !== host) {
          writeJson(response, { ok: false, error: 'forbidden origin' }, 403)
          return
        }
      }

      const url = new URL(asString(request.url) || '/', 'http://hermes-plugins.local')
      let rest = url.pathname.startsWith(FALLBACK_PREFIX) ? url.pathname.slice(FALLBACK_PREFIX.length) : url.pathname
      rest = rest.replace(/^\/+/u, '')
      if (rest.startsWith('api/')) rest = rest.slice(4)
      const segments = rest.split('/').filter((segment) => segment !== '')
      const op = segments.shift() ?? ''
      const method = asString(request.method).toUpperCase() || 'GET'

      if (op === '') {
        writeJson(response, { ok: false, error: 'unknown operation' }, 404)
        return
      }

      const query = url.searchParams
      let params = {}
      if (op === 'backend' && segments.length > 0) {
        // Path-style proxy: /hermes-plugins/backend/<plugin>/<rest…>
        params.name = decodeURIComponent(segments.shift())
        params.path = `/${segments.map((segment) => decodeURIComponent(segment)).join('/')}`
        params.method = method
        if (query.size > 0) params.path += `?${query.toString()}`
        if (method !== 'GET' && method !== 'HEAD') {
          const raw = await readNodeBody(request, MAX_BACKEND_BODY_BYTES)
          if (raw.trim() !== '') {
            try {
              params.body = JSON.parse(raw)
            } catch {
              params.body = raw
            }
          }
        }
      } else if (method === 'POST') {
        const raw = await readNodeBody(request, op === 'backend' ? MAX_BACKEND_BODY_BYTES : MAX_BODY_BYTES)
        if (raw.trim() !== '') {
          try {
            const parsed = JSON.parse(raw)
            params = isObject(parsed) ? parsed : {}
          } catch {
            writeJson(response, { ok: false, error: 'expected a JSON body' }, 400)
            return
          }
        }
      } else {
        for (const [key, value] of query.entries()) params[key] = value
      }

      const allowed = METHOD_TABLE[op]
      if (allowed && !allowed.includes(method)) {
        writeJson(response, { ok: false, error: `${allowed.join('/')} required` }, 405)
        return
      }

      const result = await operations.run(op, params, method)
      if (result && typeof result === 'object' && result.raw === true) {
        writeText(response, result.text, asString(result.contentType) || 'application/json; charset=utf-8', Number(result.status) || 200)
        return
      }
      if (result && typeof result === 'object' && typeof result.text === 'string' && typeof result.contentType === 'string') {
        writeText(response, result.text, result.contentType, Number(result.status) || 200)
        return
      }
      writeJson(response, result)
    } catch (error) {
      const status = Number(error?.status) || 500
      log(`fallback route failed (${status}): ${error?.message ?? error}`)
      try {
        writeJson(response, { ok: false, error: asString(error?.message) || 'internal error' }, status)
      } catch {}
    }
  }
}

/** Methods the raw-node carrier accepts per operation. */
const METHOD_TABLE = {
  list: ['GET', 'HEAD'],
  install: ['POST'],
  remove: ['POST'],
  source: ['GET', 'HEAD'],
  module: ['GET', 'HEAD'],
  health: ['GET', 'HEAD'],
  'data-source': ['GET', 'HEAD', 'POST'],
  backend: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}

/**
 * Register the raw-node fallback route on the Web carrier.
 * @returns `true` when a registration was attempted.
 */
export function registerFallbackRoute(ctx, { webServer, operations, registerWithRetry, log = () => {} }) {
  if (!webServer || typeof webServer.register !== 'function') return false
  const handler = createNodeHandler(operations, { log })
  ctx.effect(
    () => registerWithRetry(() => webServer.register({ kind: 'prefix', path: FALLBACK_PREFIX, handler }), `the same-origin ${FALLBACK_PREFIX} route`),
    `hermes-plugin-host: same-origin ${FALLBACK_PREFIX} route`,
  )
  log(`registered the same-origin fallback route under ${FALLBACK_PREFIX}`)
  return true
}
