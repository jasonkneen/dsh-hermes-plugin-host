/**
 * web/runtime.js — loads a Hermes Desktop `desktop/plugin.js` into the
 * DeepSeek Harness Web UI.
 *
 * IMPORTANT: this file is loaded as a **blob-URL ES module**, so it must not
 * contain a single import statement or bare specifier. React and the
 * `@hermes/plugin-sdk` shim arrive through `createHermesRuntime({ React,
 * createSdk })`; every cross-module link is a generated blob module.
 *
 * Public surface (CONTRACT.md §E):
 *
 *   const runtime = createHermesRuntime({ React, createSdk, api })
 *   const instance = await runtime.load(pluginInfo, sourceText)
 *
 * `api` is optional and injects the backend transport:
 *   api.rest(pluginName, path, init) -> Promise<any>   (replaces internal REST)
 *   api.storage(pluginName) -> { get, set, delete }    (replaces internal storage)
 * Anything not provided falls back to the runtime's internal implementation
 * (which probes `/api/hermes-plugins/backend` then `/hermes-plugins/backend`).
 *
 *   instance = { id, info, Root, routes, statusBar, palette, keybinds,
 *                settings, error, navigate, notify, dispose }
 */

// ---------------------------------------------------------------------------
// React namespace re-export blob — the only React the plugin ever sees.
// ---------------------------------------------------------------------------
const REACT_EXPORTS = [
  'useState',
  'useEffect',
  'useLayoutEffect',
  'useMemo',
  'useRef',
  'useCallback',
  'useReducer',
  'useContext',
  'useId',
  'useSyncExternalStore',
  'useTransition',
  'useDeferredValue',
  'useImperativeHandle',
  'useDebugValue',
  'useInsertionEffect',
  'useOptimistic',
  'useActionState',
  'memo',
  'forwardRef',
  'lazy',
  'Suspense',
  'Fragment',
  'StrictMode',
  'Profiler',
  'createElement',
  'cloneElement',
  'createContext',
  'createRef',
  'createFactory',
  'isValidElement',
  'Children',
  'Component',
  'PureComponent',
  'startTransition',
]

const JSX_RUNTIME_EXPORTS = ['jsx', 'jsxs', 'jsxDEV', 'Fragment']

function buildReactModuleSource(globalName) {
  const lines = ['const R = globalThis[' + JSON.stringify(globalName) + '];']
  lines.push('if (!R) throw new Error("[hermes-runtime] React global missing");')
  lines.push('export default R;')
  for (const name of REACT_EXPORTS) lines.push('export const ' + name + ' = R.' + name + ';')
  return lines.join('\n')
}

function buildJsxRuntimeModuleSource(globalName) {
  return [
    'const R = globalThis[' + JSON.stringify(globalName) + '];',
    'if (!R) throw new Error("[hermes-runtime] React global missing");',
    'function makeElement(type, props, key) {',
    '  var p = props || {};',
    '  if (key !== undefined) { p = Object.assign({}, p); p.key = key; }',
    '  return R.createElement(type, p);',
    '}',
    'export const jsx = makeElement;',
    'export const jsxs = makeElement;',
    'export const jsxDEV = makeElement;',
    'export const Fragment = R.Fragment;',
    'export default { jsx: makeElement, jsxs: makeElement, jsxDEV: makeElement, Fragment: R.Fragment };',
  ].join('\n')
}

function buildSdkModuleSource(registryName, token, exportNames) {
  const lines = [
    'const S = globalThis[' + JSON.stringify(registryName) + '].get(' + JSON.stringify(token) + ');',
    'if (!S) throw new Error("[hermes-runtime] plugin SDK instance is not available");',
    'export default S;',
  ]
  for (const name of exportNames) lines.push('export const ' + name + ' = S.' + name + ';')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Specifier rewriting
//
// Rewrites the three allowed bare specifiers (in static imports, re-exports,
// side-effect imports and dynamic import()) to the generated blob URLs. Quotes
// may be single or double; the import form may span lines.
// ---------------------------------------------------------------------------
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"\r\n]+)\2/g

/**
 * Spans of the source that are string literals, template literals or comments.
 * A specifier match that starts inside one of them is prose, not an import, and
 * must be left alone (e.g. a plugin string that literally contains
 * "from 'react'"). Only a handful of spans exist, so a linear scan is fine.
 */
function protectedSpans(source) {
  const spans = []
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    if (ch === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index)
      const end = newline < 0 ? source.length : newline
      spans.push([index, end])
      index = end
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2)
      const end = close < 0 ? source.length : close + 2
      spans.push([index, end])
      index = end
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let i = index + 1
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === ch) {
          i += 1
          break
        }
        i += 1
      }
      spans.push([index, i])
      index = i
      continue
    }
    index += 1
  }
  return spans
}

function isProtected(spans, position) {
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]
    if (position >= span[0] && position < span[1]) return true
    if (span[0] > position) return false
  }
  return false
}

export function rewriteSpecifiers(source, specifierMap) {
  if (typeof source !== 'string') throw new TypeError('rewriteSpecifiers: source must be a string')
  const map = specifierMap || {}
  const spans = protectedSpans(source)
  return source.replace(SPECIFIER_RE, (match, prefix, quote, specifier, offset) => {
    if (isProtected(spans, offset)) return match
    const replacement = map[specifier]
    if (!replacement) return match
    return prefix + quote + replacement + quote
  })
}

/** The bare specifiers a Hermes plugin is allowed to import. */
export const ALLOWED_SPECIFIERS = Object.freeze(['react', 'react/jsx-runtime', '@hermes/plugin-sdk'])

// ---------------------------------------------------------------------------
// DOM-free helpers
// ---------------------------------------------------------------------------
let blobSeq = 0

function makeModuleUrl(source) {
  blobSeq += 1
  const blob = new Blob([source], { type: 'text/javascript' })
  return URL.createObjectURL(blob)
}

function revokeUrl(url) {
  if (!url) return
  try {
    URL.revokeObjectURL(url)
  } catch (err) {
    /* ignore */
  }
}

function errorMessage(err) {
  if (!err) return 'unknown error'
  if (typeof err === 'string') return err
  if (err.message) return String(err.message)
  return String(err)
}

function errorStack(err) {
  return err && err.stack ? String(err.stack) : ''
}

// ---------------------------------------------------------------------------
// Caller-injected transport
//
// createHermesRuntime({ React, createSdk, api }) accepts an optional `api`:
//   api.rest(pluginName, path, init) -> Promise<any>   (replaces internal)
//   api.storage(pluginName) -> { get, set, delete }    (replaces internal)
// Each method that is provided REPLACES the runtime's internal implementation;
// anything absent falls back to the internal one. This lets the client own the
// two-carrier backend selection (and any auth/retry policy) without the runtime
// knowing about it.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Internal REST transport (only used when the caller does not inject api.rest)
//
// Two backend carriers are live in the DSH host:
//   1. PRIMARY — an exact-path Connection route at `/api/hermes-plugins/backend`
//      (GET/HEAD/POST only, no wildcards). Params travel in the query string on
//      GET and in a JSON body on POST:
//        GET  /api/hermes-plugins/backend?name=<n>&path=%2Fstate
//        POST /api/hermes-plugins/backend
//             { name, path: '/state', method: 'GET|POST|...', body }
//   2. FALLBACK — a raw-node path-style prefix:
//        GET /hermes-plugins/backend/<plugin>/<rest...>
//
// `/hermes-plugins/api/...` does not exist. The internal transport probes the
// primary carrier first, falls back once on a non-JSON/network failure, and
// remembers which carrier answered. A JSON response — including a plugin's
// authentic 404/405 `{"detail":…}` — is always a real answer, never a miss.
// ---------------------------------------------------------------------------
function normalizeApiBase(value) {
  let base = String(value == null ? '' : value).trim().replace(/\/+$/, '')
  // Accept the legacy '/hermes-plugins/api' spelling by trimming the '/api'.
  if (base.length > 4 && base.slice(-4) === '/api') base = base.slice(0, -4)
  return base
}

function internalCarriers(apiBase) {
  const declared = apiBase == null ? '' : normalizeApiBase(apiBase)
  if (declared) {
    return [{ base: declared, style: declared.indexOf('/api/') === 0 ? 'envelope' : 'path' }]
  }
  return [
    { base: '/api/hermes-plugins', style: 'envelope' },
    { base: '/hermes-plugins', style: 'path' },
  ]
}

function headerValue(headers, name) {
  if (!headers) return undefined
  const wanted = String(name).toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key]
  }
  return undefined
}

/** Carrier-envelope body: parsed JSON when possible, else the raw string. */
function encodeEnvelopeBody(body) {
  if (body === undefined || body === null) return null
  if (typeof body === 'string') {
    const trimmed = body.trim()
    if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
      try {
        return JSON.parse(trimmed)
      } catch (err) {
        /* keep the raw string */
      }
    }
    return body
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) return null
  return body
}

function sendCarrierRequest(carrier, name, cleanPath, method, init) {
  const isRead = method === 'GET' || method === 'HEAD'

  if (carrier.style === 'path') {
    const headers = Object.assign({ accept: 'application/json' }, (init && init.headers) || {})
    const url = carrier.base + '/backend/' + encodeURIComponent(name) + (cleanPath ? '/' + cleanPath : '')
    const options = { method, credentials: 'same-origin', headers }
    if (!isRead && init && init.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string' || (typeof FormData !== 'undefined' && init.body instanceof FormData)) {
        options.body = init.body
      } else {
        options.body = JSON.stringify(init.body)
        if (headerValue(headers, 'content-type') === undefined) headers['content-type'] = 'application/json'
      }
    }
    return fetch(url, options)
  }

  // Envelope carrier (exact path + query/body params, methods GET/HEAD/POST).
  if (isRead) {
    const headers = Object.assign({ accept: 'application/json' }, (init && init.headers) || {})
    const url =
      carrier.base +
      '/backend?name=' +
      encodeURIComponent(name) +
      '&path=' +
      encodeURIComponent('/' + cleanPath)
    return fetch(url, { method, credentials: 'same-origin', headers })
  }
  const headers = Object.assign({ accept: 'application/json', 'content-type': 'application/json' }, (init && init.headers) || {})
  const envelope = { name, path: '/' + cleanPath, method, body: encodeEnvelopeBody(init && init.body) }
  return fetch(carrier.base + '/backend', {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(envelope),
  })
}

async function readCarrierResponse(response) {
  let text = ''
  try {
    text = await response.text()
  } catch (err) {
    text = ''
  }
  let contentType = ''
  try {
    contentType = String((response.headers && response.headers.get('content-type')) || '')
  } catch (err) {
    contentType = ''
  }
  let payload = null
  let parsed = false
  if (text) {
    try {
      payload = JSON.parse(text)
      parsed = true
    } catch (err) {
      payload = text
    }
  }
  return { response, text, contentType, payload, parsed }
}

/**
 * True ONLY when the response proves no host route owned the path:
 *   - a network error (thrown before we get here), or
 *   - the SPA fallback: an HTML document (text/html, or a body that opens with
 *     a doctype/<html>), or any non-2xx non-JSON response.
 *
 * Every JSON response is a real answer and must never mark a carrier dead:
 *   - plugin responses, including authentic `{"detail":"…"}` 404/405 bodies,
 *     are passed through/thrown verbatim;
 *   - host-side failures are `{"ok":false,"error":"…"}` and surface as errors.
 * A legitimate plugin 404 at a mistyped sub-path must not permanently fall
 * back to the other carrier for the rest of the session.
 *
 * A 2xx non-JSON, non-HTML body is also treated as a real plugin answer (a
 * Hermes backend half could legitimately stream text/plain or a file); the
 * caller gets the raw text instead of a bogus fallback probe.
 */
function looksLikeHtmlDocument(result) {
  if (/html/i.test(result.contentType)) return true
  const sample = typeof result.text === 'string' ? result.text.trim().slice(0, 256).toLowerCase() : ''
  return sample.indexOf('<!doctype') === 0 || sample.indexOf('<html') === 0
}

function isCarrierMiss(result) {
  if (/json/i.test(result.contentType)) return false
  if (result.parsed) return false
  const status = result.response ? result.response.status : 0
  if (status >= 200 && status < 300 && !looksLikeHtmlDocument(result)) return false
  return true
}

function finishCarrierResponse(result) {
  const response = result.response
  const payload = result.payload
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && (payload.error || payload.message || payload.detail)
        ? payload.error || payload.message || payload.detail
        : 'HTTP ' + response.status + ' ' + (response.statusText || '')
    throw new Error(String(detail).trim() || 'request failed')
  }
  if (payload && typeof payload === 'object' && payload.ok === false && typeof payload.error === 'string') {
    throw new Error(payload.error)
  }
  // Tolerate an envelope some carriers add: { ok: true, data }.
  if (
    payload &&
    typeof payload === 'object' &&
    payload.ok === true &&
    Object.prototype.hasOwnProperty.call(payload, 'data') &&
    Object.keys(payload).length === 2
  ) {
    return payload.data
  }
  return payload
}

function createRestClient(apiBase) {
  const carriers = internalCarriers(apiBase)
  let resolved = null

  return async function rest(pluginName, path, init) {
    const name = String(pluginName == null ? '' : pluginName)
    const cleanPath = String(path == null ? '' : path).replace(/^\/+/, '')
    const method = String((init && init.method) || 'GET').toUpperCase()
    const attempts = resolved ? [resolved] : carriers
    const tried = []
    let lastError = null

    for (let i = 0; i < attempts.length; i++) {
      const carrier = attempts[i]
      const isLast = i === attempts.length - 1
      tried.push(carrier.base)
      let result
      try {
        const response = await sendCarrierRequest(carrier, name, cleanPath, method, init)
        result = await readCarrierResponse(response)
      } catch (err) {
        lastError = err
        if (isLast) throw err
        continue
      }
      if (isCarrierMiss(result)) {
        // Non-JSON / network failure: this carrier does not serve the backend.
        lastError = new Error(
          'HTTP ' +
            (result.response ? result.response.status : '?') +
            ' from ' +
            carrier.base +
            ' — backend carrier unavailable (non-JSON response)',
        )
        if (isLast) throw lastError
        continue
      }
      resolved = carrier
      return finishCarrierResponse(result)
    }
    if (lastError) throw lastError
    throw new Error('hermes backend request failed (tried ' + tried.join(', ') + ')')
  }
}

function createStorage(pluginName) {
  const prefix = 'hph:' + String(pluginName) + ':'
  const memory = new Map()
  let local = null
  try {
    local = window.localStorage
  } catch (err) {
    local = null
  }
  const read = (key) => {
    if (local) {
      try {
        return local.getItem(key)
      } catch (err) {
        return memory.has(key) ? memory.get(key) : null
      }
    }
    return memory.has(key) ? memory.get(key) : null
  }
  const write = (key, raw) => {
    if (local) {
      try {
        local.setItem(key, raw)
        return
      } catch (err) {
        /* fall through to memory */
      }
    }
    memory.set(key, raw)
  }
  const remove = (key) => {
    if (local) {
      try {
        local.removeItem(key)
      } catch (err) {
        /* ignore */
      }
    }
    memory.delete(key)
  }
  const storage = {
    get(key, defaultValue) {
      const raw = read(prefix + String(key))
      if (raw == null) return defaultValue
      try {
        return JSON.parse(raw)
      } catch (err) {
        return defaultValue
      }
    },
    set(key, value) {
      let raw
      try {
        raw = JSON.stringify(value)
      } catch (err) {
        raw = JSON.stringify(null)
      }
      write(prefix + String(key), raw)
      return value
    },
    delete(key) {
      remove(prefix + String(key))
    },
    remove(key) {
      remove(prefix + String(key))
    },
    has(key) {
      return read(prefix + String(key)) != null
    },
  }
  return storage
}

// ---------------------------------------------------------------------------
// createHermesRuntime
// ---------------------------------------------------------------------------
const REACT_GLOBAL = '__dshHermesReact'
const SDK_REGISTRY = '__dshHermesSdkRegistry'

const TOAST_TTL_MS = 6000
const MAX_TOASTS = 6

/**
 * Merge a caller-provided `api.host` over the runtime's own host surface.
 *
 * The runtime implements `navigate`, `notify` and `notifyError` itself (they
 * drive the in-page route and the toast stack). A plugin's `host.newChat`,
 * `host.openSession` and `host.request` have no in-page equivalent — they are
 * real Harness navigation — so the Client injects those and wins for any member
 * it supplies, while everything else keeps the runtime's implementation.
 *
 * `controller.host` is rebuilt per instance, so this copies the function
 * references rather than mutating it.
 */
function mergeHost(base, injected) {
  if (!injected || typeof injected !== 'object') return base
  const merged = Object.assign({}, base)
  for (const key of Object.keys(injected)) {
    if (typeof injected[key] === 'function') merged[key] = injected[key]
  }
  return merged
}

export function createHermesRuntime(options) {
  const opts = options || {}
  const React = opts.React
  const createSdk = opts.createSdk
  const apiBase = opts.apiBase
  const injectedApi = opts.api && typeof opts.api === 'object' ? opts.api : {}

  if (!React || typeof React.createElement !== 'function') {
    throw new Error('createHermesRuntime: React is required')
  }
  if (typeof createSdk !== 'function') {
    throw new Error('createHermesRuntime: createSdk is required')
  }

  // The generated React blob reads the real React off the global the client set.
  globalThis[REACT_GLOBAL] = React
  if (!globalThis[SDK_REGISTRY]) globalThis[SDK_REGISTRY] = new Map()
  const sdkRegistry = globalThis[SDK_REGISTRY]

  const R = React
  const el = R.createElement

  // -- shared blob modules (built once per runtime) -------------------------
  let reactUrl = null
  let jsxUrl = null
  const getReactUrl = () => {
    if (!reactUrl) reactUrl = makeModuleUrl(buildReactModuleSource(REACT_GLOBAL))
    return reactUrl
  }
  const getJsxRuntimeUrl = () => {
    if (!jsxUrl) jsxUrl = makeModuleUrl(buildJsxRuntimeModuleSource(REACT_GLOBAL))
    return jsxUrl
  }

  // Transport: a caller-provided api.rest / api.storage replaces the internal
  // implementation for that method only. The client owns two-carrier selection.
  const internalRest = createRestClient(apiBase)
  const hasInjectedRest = typeof injectedApi.rest === 'function'
  const hasInjectedStorage = typeof injectedApi.storage === 'function'

  const restRequest = (pluginName, path, init) => {
    const target = String(pluginName == null ? '' : pluginName)
    if (hasInjectedRest) return injectedApi.rest(target, path, init)
    return internalRest(target, path, init)
  }

  const storageCache = new Map()
  const storageFor = (pluginName) => {
    const key = String(pluginName == null ? '' : pluginName)
    if (storageCache.has(key)) return storageCache.get(key)
    let value = null
    if (hasInjectedStorage) {
      try {
        const provided = injectedApi.storage(key)
        if (provided && typeof provided.get === 'function' && typeof provided.set === 'function') {
          value = provided
        } else {
          console.warn('[hermes-runtime] api.storage() returned an unusable object for "' + key + '"; using internal storage')
        }
      } catch (err) {
        console.warn('[hermes-runtime] api.storage() threw for "' + key + '"; using internal storage', err)
      }
    }
    if (!value) value = createStorage(key)
    storageCache.set(key, value)
    return value
  }

  const instances = new Map()
  let instanceSeq = 0

  // -- error boundary -------------------------------------------------------
  function makeBoundary(title) {
    return class PluginErrorBoundary extends R.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.handleReset = this.handleReset.bind(this)
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try {
          console.error('[hermes-plugin] render error:', error, info)
        } catch (err) {
          /* ignore */
        }
      }

      handleReset() {
        this.setState({ error: null })
      }

      render() {
        const error = this.state.error
        if (!error) return this.props ? this.props.children : null
        return el(
          'div',
          { className: 'hph-error', role: 'alert' },
          el('div', { className: 'hph-error-title' }, title || 'This part of the plugin crashed'),
          el('pre', { className: 'hph-error-msg' }, errorMessage(error)),
          errorStack(error)
            ? el(
                'details',
                { className: 'hph-error-stack' },
                el('summary', null, 'Stack trace'),
                el('pre', null, errorStack(error)),
              )
            : null,
          el(
            'button',
            { type: 'button', className: 'hph-error-retry', onClick: this.handleReset },
            'Try again',
          ),
        )
      }
    }
  }

  const RouteBoundary = makeBoundary('The plugin page crashed')
  const SurfaceBoundary = makeBoundary('This plugin surface crashed')

  // -- controller: all mutable per-plugin state ----------------------------
  function createController(plugin) {
    const state = {
      version: 0,
      phase: 'loading', // loading | ready | registered | failed
      error: null, // { phase, message, stack }
      activePath: null,
      routes: [],
      nav: [],
      statusLeft: [],
      statusRight: [],
      palette: [],
      keybinds: [],
      settings: [],
      unknown: [],
      toasts: [],
    }
    // Area constants live here so ctx.register() can bucket registrations even
    // before the SDK instance exists; load() overwrites them with the exact
    // values from createSdk().
    const areas = {
      ROUTES_AREA: 'routes',
      SIDEBAR_NAV_AREA: 'sidebar-nav',
      STATUSBAR_AREAS: { left: 'statusbar-left', right: 'statusbar-right' },
      PALETTE_AREA: 'palette',
      KEYBINDS_AREA: 'keybinds',
    }
    const listeners = new Set()
    const timers = new Map()
    let toastSeq = 0
    let disposed = false

    const emit = () => {
      if (disposed) return
      state.version += 1
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch (err) {
          console.error('[hermes-plugin] listener failed:', err)
        }
      }
    }
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const getVersion = () => state.version

    // -- toasts ------------------------------------------------------------
    const dismissToast = (toastId) => {
      const timer = timers.get(toastId)
      if (timer) {
        clearTimeout(timer)
        timers.delete(toastId)
      }
      const index = state.toasts.findIndex((toast) => toast.id === toastId)
      if (index >= 0) {
        state.toasts.splice(index, 1)
        emit()
      }
    }
    const pushToast = (payload) => {
      if (disposed) return undefined
      let toast
      if (typeof payload === 'string') {
        toast = { kind: 'info', title: plugin.label || plugin.name, message: payload }
      } else if (payload && typeof payload === 'object') {
        toast = {
          kind: payload.kind || payload.type || 'info',
          title: payload.title != null ? String(payload.title) : plugin.label || plugin.name,
          message: payload.message != null ? String(payload.message) : '',
          action:
            payload.action && typeof payload.action === 'object' && typeof payload.action.label === 'string'
              ? payload.action
              : null,
          detail: payload.detail != null ? String(payload.detail) : '',
        }
      } else {
        return undefined
      }
      toastSeq += 1
      toast.id = toastSeq
      state.toasts.push(toast)
      while (state.toasts.length > MAX_TOASTS) {
        const removed = state.toasts.shift()
        const timer = timers.get(removed.id)
        if (timer) {
          clearTimeout(timer)
          timers.delete(removed.id)
        }
      }
      timers.set(
        toast.id,
        setTimeout(() => dismissToast(toast.id), TOAST_TTL_MS),
      )
      emit()
      return toast.id
    }

    // -- routes ------------------------------------------------------------
    const routePath = (registration) => {
      const data = registration && registration.data
      if (data && typeof data.path === 'string' && data.path) return data.path
      return null
    }

    const knownPaths = () => {
      const paths = []
      for (const registration of state.routes) {
        const path = routePath(registration)
        if (path && paths.indexOf(path) < 0) paths.push(path)
      }
      for (const registration of state.nav) {
        const path = routePath(registration)
        if (path && paths.indexOf(path) < 0) paths.push(path)
      }
      return paths
    }

    const firstPath = () => {
      const paths = knownPaths()
      return paths.length ? paths[0] : null
    }

    const navigate = (path) => {
      if (disposed) return false
      const target = String(path == null ? '' : path)
      if (!target) return false
      if (knownPaths().indexOf(target) < 0) {
        pushToast({
          kind: 'warn',
          title: plugin.label || plugin.name,
          message: 'Route "' + target + '" is not registered in DeepSeek Harness.',
        })
        return false
      }
      if (state.activePath !== target) {
        state.activePath = target
        emit()
      }
      return true
    }

    // -- host --------------------------------------------------------------
    const host = {
      navigate,
      notify(payload) {
        return pushToast(payload)
      },
      notifyError(err, message) {
        const detail = errorMessage(err)
        const text = message ? String(message) + (detail ? ' — ' + detail : '') : detail
        return pushToast({ kind: 'error', title: plugin.label || plugin.name, message: text, detail: errorStack(err) })
      },
      newChat(profile) {
        pushToast({
          kind: 'warn',
          title: plugin.label || plugin.name,
          message:
            'New chat' +
            (profile ? ' in profile "' + profile + '"' : '') +
            ' is not available in DeepSeek Harness.',
        })
        return Promise.resolve(undefined)
      },
      openSession(sessionId, sessionOptions) {
        pushToast({
          kind: 'warn',
          title: plugin.label || plugin.name,
          message:
            'Opening session ' +
            String(sessionId) +
            (sessionOptions && sessionOptions.profile ? ' (profile "' + sessionOptions.profile + '")' : '') +
            ' is not available in DeepSeek Harness.',
        })
        return Promise.resolve(undefined)
      },
      request(method, params) {
        pushToast({
          kind: 'warn',
          title: plugin.label || plugin.name,
          message: 'Hermes RPC "' + String(method) + '" is not available in DeepSeek Harness.',
        })
        return Promise.resolve(undefined)
      },
    }

    // -- registrations -----------------------------------------------------
    const buckets = {
      ROUTES_AREA: state.routes,
      SIDEBAR_NAV_AREA: state.nav,
      PALETTE_AREA: state.palette,
      KEYBINDS_AREA: state.keybinds,
      STATUSBAR_LEFT: state.statusLeft,
      STATUSBAR_RIGHT: state.statusRight,
    }
    const seens = new Set()
    let registrationFlush = null

    const bucketForArea = (area) => {
      if (area === areas.ROUTES_AREA) return buckets.ROUTES_AREA
      if (area === areas.SIDEBAR_NAV_AREA) return buckets.SIDEBAR_NAV_AREA
      if (area === areas.PALETTE_AREA) return buckets.PALETTE_AREA
      if (area === areas.KEYBINDS_AREA) return buckets.KEYBINDS_AREA
      if (areas.STATUSBAR_AREAS && area === areas.STATUSBAR_AREAS.left) return buckets.STATUSBAR_LEFT
      if (areas.STATUSBAR_AREAS && area === areas.STATUSBAR_AREAS.right) return buckets.STATUSBAR_RIGHT
      return null
    }

    const scheduleFlush = () => {
      if (registrationFlush) return
      registrationFlush = Promise.resolve().then(() => {
        registrationFlush = null
        for (const list of [state.routes, state.nav, state.palette, state.keybinds, state.statusLeft, state.statusRight]) {
          list.sort((a, b) => {
            const ao = typeof a.order === 'number' ? a.order : 0
            const bo = typeof b.order === 'number' ? b.order : 0
            return ao - bo
          })
        }
        if (!state.activePath) state.activePath = firstPath()
        emit()
      })
    }

    const register = (registration) => {
      if (disposed) return
      if (!registration || typeof registration !== 'object') {
        pushToast({ kind: 'error', title: plugin.label || plugin.name, message: 'ctx.register() needs a registration object.' })
        return
      }
      const area = registration.area
      const bucket = bucketForArea(area)
      const id = registration.id != null ? String(registration.id) : '(no id)'
      if (!bucket) {
        state.unknown.push({ id, area: String(area) })
        pushToast({
          kind: 'warn',
          title: plugin.label || plugin.name,
          message: 'Unknown plugin area "' + String(area) + '" — registration "' + id + '" ignored.',
        })
        return
      }
      const key = String(area) + '|' + id
      if (seens.has(key)) {
        pushToast({
          kind: 'warn',
          title: plugin.label || plugin.name,
          message: 'Duplicate registration "' + id + '" for area "' + String(area) + '" ignored.',
        })
        return
      }
      seens.add(key)
      bucket.push({
        id,
        area,
        order: typeof registration.order === 'number' ? registration.order : 0,
        data: registration.data && typeof registration.data === 'object' ? registration.data : {},
        render: typeof registration.render === 'function' ? registration.render : null,
        meta: registration.meta,
      })
      scheduleFlush()
    }

    const registerSettingsPage = (page) => {
      if (disposed || !page || typeof page !== 'object') return
      const id = page.id != null ? String(page.id) : 'settings-' + (state.settings.length + 1)
      const key = 'settings|' + id
      if (seens.has(key)) return
      seens.add(key)
      state.settings.push({
        id,
        title: page.title != null ? String(page.title) : id,
        icon: page.icon,
        order: typeof page.order === 'number' ? page.order : 0,
        render: typeof page.render === 'function' ? page.render : null,
        data: page.data,
        meta: page.meta,
      })
      state.settings.sort((a, b) => a.order - b.order)
      emit()
    }

    const fail = (phase, err) => {
      state.error = { phase, message: errorMessage(err), stack: errorStack(err) }
      state.phase = 'failed'
      emit()
      try {
        console.error('[hermes-plugin] ' + phase + ' failed:', err)
      } catch (e) {
        /* ignore */
      }
    }

    const dispose = () => {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      listeners.clear()
      state.toasts.length = 0
    }

    return {
      plugin,
      state,
      areas,
      setAreas(next) {
        if (!next || typeof next !== 'object') return
        for (const key of Object.keys(areas)) {
          if (next[key] !== undefined) areas[key] = next[key]
        }
      },
      host,
      register,
      registerSettingsPage,
      fail,
      dispose,
      subscribe,
      getVersion,
      navigate,
      notify: host.notify,
      dismissToast,
      get disposed() {
        return disposed
      },
      setPhase(phase) {
        state.phase = phase
        emit()
      },
    }
  }

  // -- Root ----------------------------------------------------------------
  function makeRoot(controller) {
    const showToast = (toast) =>
      el(
        'div',
        { className: 'hph-toast hph-toast-' + String(toast.kind || 'info'), key: toast.id, role: 'status' },
        el(
          'div',
          { className: 'hph-toast-body' },
          el('div', { className: 'hph-toast-title' }, toast.title),
          toast.message ? el('div', { className: 'hph-toast-msg' }, toast.message) : null,
          toast.action && typeof toast.action.onClick === 'function'
            ? el(
                'button',
                {
                  type: 'button',
                  className: 'hph-toast-action',
                  onClick: () => {
                    controller.dismissToast(toast.id)
                    try {
                      toast.action.onClick()
                    } catch (err) {
                      controller.notify({
                        kind: 'error',
                        title: 'Plugin action failed',
                        message: errorMessage(err),
                      })
                    }
                  },
                },
                String(toast.action.label || 'Open'),
              )
            : null,
        ),
        el(
          'button',
          {
            type: 'button',
            className: 'hph-toast-close',
            'aria-label': 'Dismiss',
            onClick: () => controller.dismissToast(toast.id),
          },
          '\u00d7',
        ),
      )

    // One plugin surface (route page, status chip) with its own boundary.
    function PluginSurface(props) {
      const render = props.render
      if (typeof render !== 'function') return null
      const node = render()
      return node == null ? null : node
    }

    function collectTabs() {
      const tabs = []
      const byPath = new Map()
      for (const registration of controller.state.nav) {
        const path = registration.data && typeof registration.data.path === 'string' ? registration.data.path : null
        if (!path) continue
        const label =
          (registration.data && (registration.data.label || registration.data.title)) || path
        const tab = { path, label: String(label), codicon: registration.data && registration.data.codicon }
        byPath.set(path, tab)
        tabs.push(tab)
      }
      for (const registration of controller.state.routes) {
        const path = registration.data && typeof registration.data.path === 'string' ? registration.data.path : null
        if (!path) continue
        if (byPath.has(path)) continue
        const label = (registration.data && (registration.data.label || registration.data.title)) || path
        const tab = { path, label: String(label) }
        byPath.set(path, tab)
        tabs.push(tab)
      }
      return tabs
    }

    function Root() {
      const version = R.useSyncExternalStore(controller.subscribe, controller.getVersion, controller.getVersion)
      void version
      const state = controller.state
      const tabs = collectTabs()
      const activePath = state.activePath || (tabs.length ? tabs[0].path : null)
      const activeRoute =
        state.routes.find((registration) => {
          const path = registration.data && typeof registration.data.path === 'string' ? registration.data.path : null
          return path === activePath
        }) || null
      const tabList = tabs.length > 1
        ? el(
            'div',
            { className: 'hph-tabs', role: 'tablist' },
            tabs.map((tab) =>
              el(
                'button',
                {
                  key: tab.path,
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab.path === activePath,
                  className: 'hph-tab' + (tab.path === activePath ? ' hph-tab-active' : ''),
                  onClick: () => controller.navigate(tab.path),
                },
                tab.codicon ? el('span', { className: 'hph-tab-icon', 'aria-hidden': true }, tab.codicon) : null,
                tab.label,
              ),
            ),
          )
        : null

      let content
      if (state.error && state.phase === 'failed' && !state.routes.length) {
        content = el(
          'div',
          { className: 'hph-error', role: 'alert' },
          el('div', { className: 'hph-error-title' }, 'Could not run this Hermes plugin'),
          el('pre', { className: 'hph-error-msg' }, state.error.message),
          state.error.phase ? el('div', { className: 'hph-error-phase' }, 'during ' + state.error.phase) : null,
          state.error.stack
            ? el(
                'details',
                { className: 'hph-error-stack' },
                el('summary', null, 'Stack trace'),
                el('pre', null, state.error.stack),
              )
            : null,
        )
      } else if (!activePath) {
        content = el(
          'div',
          { className: 'hph-empty' },
          el('div', { className: 'hph-empty-title' }, (controller.plugin.label || controller.plugin.name) + ' registered no pages'),
          el('div', { className: 'hph-empty-desc' }, 'The plugin loaded but did not register a ROUTES_AREA page.'),
        )
      } else if (!activeRoute) {
        content = el(
          'div',
          { className: 'hph-empty' },
          el('div', { className: 'hph-empty-title' }, 'No page for ' + activePath),
          el('div', { className: 'hph-empty-desc' }, 'This path is registered as a sidebar entry only.'),
        )
      } else {
        content = el(
          RouteBoundary,
          { key: activePath },
          el(PluginSurface, { render: activeRoute.render }),
        )
      }

      const errorBanner =
        state.error && state.phase === 'failed' && state.routes.length
          ? el(
              'div',
              { className: 'hph-error hph-error-banner', role: 'alert' },
              el('div', { className: 'hph-error-title' }, 'Plugin failed to finish loading'),
              el('pre', { className: 'hph-error-msg' }, state.error.message),
            )
          : null

      const statusRegistrations = state.statusLeft.concat(state.statusRight)
      const statusBar =
        statusRegistrations.length > 0
          ? el(
              'div',
              { className: 'hph-statusbar' },
              el(
                'div',
                { className: 'hph-statusbar-left' },
                state.statusLeft.map((registration) =>
                  el(
                    SurfaceBoundary,
                    { key: 'status-l-' + registration.id },
                    el(PluginSurface, { render: registration.render }),
                  ),
                ),
              ),
              el(
                'div',
                { className: 'hph-statusbar-right' },
                state.statusRight.map((registration) =>
                  el(
                    SurfaceBoundary,
                    { key: 'status-r-' + registration.id },
                    el(PluginSurface, { render: registration.render }),
                  ),
                ),
              ),
            )
          : null

      const toasts = state.toasts.length
        ? el('div', { className: 'hph-toasts', role: 'log', 'aria-live': 'polite' }, state.toasts.map(showToast))
        : null

      return el(
        'div',
        { className: 'hph-root', 'data-hermes-plugin': controller.plugin.name },
        tabList,
        errorBanner,
        el('div', { className: 'hph-route' }, content),
        statusBar,
        toasts,
      )
    }

    return Root
  }

  // -- load ----------------------------------------------------------------
  async function load(pluginInfo, sourceText) {
    const info = pluginInfo && typeof pluginInfo === 'object' ? pluginInfo : { name: 'hermes-plugin' }
    const name = String(info.name || info.id || 'hermes-plugin')
    const label = String(info.label || name)
    instanceSeq += 1
    const token = name + '#' + instanceSeq

    const controller = createController({ name, label, info })

    // 1. SDK instance for this plugin (one per load: fresh query cache + host).
    let sdkUrl = null
    let pluginUrl = null
    const storage = storageFor(name)
    const rest = (path, init) => restRequest(name, path, init)
    let sdkResult = null
    try {
      sdkResult = createSdk({
        React: R,
        pluginId: token,
        api: {
          rest: (pluginName, path, init) => restRequest(pluginName || name, path, init),
          storage: (pluginName) => storageFor(pluginName || name),
          host: mergeHost(controller.host, injectedApi.host),
        },
      })
    } catch (err) {
      controller.fail('createSdk', err)
      sdkResult = null
    }

    if (sdkResult) {
      controller.setAreas(sdkResult.AREAS)
      controller.sdk = sdkResult.sdk
      sdkRegistry.set(token, sdkResult.sdk)
      sdkUrl = makeModuleUrl(buildSdkModuleSource(SDK_REGISTRY, token, sdkResult.exportNames || []))
    }

    // 2. Register the instance so `host.navigate`/toasts reach this controller.
    const Root = makeRoot(controller)

    const instance = {
      id: name,
      info,
      token,
      Root,
      get routes() {
        return controller.state.routes
          .map((registration) => {
            const path =
              registration.data && typeof registration.data.path === 'string' ? registration.data.path : ''
            return path ? { path, label: registration.data.label || registration.data.title || path } : null
          })
          .filter(Boolean)
      },
      get statusBar() {
        return controller.state.statusLeft.concat(controller.state.statusRight)
      },
      get palette() {
        return controller.state.palette
      },
      get keybinds() {
        return controller.state.keybinds
      },
      get settings() {
        return controller.state.settings
      },
      get error() {
        return controller.state.error
      },
      get phase() {
        return controller.state.phase
      },
      navigate: (path) => controller.navigate(path),
      notify: (payload) => controller.notify(payload),
      subscribe: controller.subscribe,
      getVersion: controller.getVersion,
      dispose() {
        try {
          controller.dispose()
        } finally {
          sdkRegistry.delete(token)
          revokeUrl(sdkUrl)
          revokeUrl(pluginUrl)
          instances.delete(token)
        }
      },
    }

    instances.set(token, instance)

    if (!sdkResult) {
      controller.setPhase('failed')
      return instance
    }

    // 3. Rewrite + evaluate the plugin module.
    const source = String(sourceText == null ? '' : sourceText)
    if (!source.trim()) {
      controller.fail(
        'source',
        new Error('No desktop/plugin.js source was supplied for "' + name + '". Fetch it from the plugin host api/source endpoint first.'),
      )
      return instance
    }

    const specifierMap = {
      react: getReactUrl(),
      'react/jsx-runtime': getJsxRuntimeUrl(),
      '@hermes/plugin-sdk': sdkUrl,
    }

    let transformed
    try {
      transformed = rewriteSpecifiers(source, specifierMap)
    } catch (err) {
      controller.fail('rewrite', err)
      return instance
    }

    // Fail loudly if a bare specifier survived (unknown import or bad quoting).
    const leftover = transformed.match(/\bfrom\s*(['"])(react|react\/jsx-runtime|@hermes\/plugin-sdk)\1/)
    if (leftover) {
      controller.fail(
        'rewrite',
        new Error('Could not rewrite the bare specifier ' + leftover[2] + ' in the plugin source.'),
      )
      return instance
    }

    pluginUrl = makeModuleUrl(transformed)
    let moduleExports = null
    try {
      moduleExports = await import(/* @vite-ignore */ pluginUrl)
    } catch (err) {
      controller.fail('import', err)
      return instance
    }

    const pluginDefault =
      (moduleExports && moduleExports.default) ||
      (moduleExports && moduleExports.plugin) ||
      moduleExports ||
      null

    if (!pluginDefault || typeof pluginDefault.register !== 'function') {
      controller.fail('register', new Error('The plugin has no default export with a register(ctx) function.'))
      return instance
    }

    // 4. Build ctx and let the plugin register its surfaces.
    const ctx = {
      /** Plugin identity, handy for diagnostics. */
      plugin: { name, label, dir: info.dir, info },
      register: (registration) => controller.register(registration),
      storage,
      rest,
      registerSettingsPage: (page) => controller.registerSettingsPage(page),
      host: controller.host,
      /** Optional lifecycle hook some hosts provide. */
      onDispose(fn) {
        if (typeof fn !== 'function') return
        const previous = instance.dispose
        instance.dispose = () => {
          try {
            fn()
          } catch (err) {
            console.error('[hermes-plugin] dispose hook failed:', err)
          }
          previous()
        }
      },
      log: (...args) => {
        try {
          console.log('[hermes-plugin:' + name + ']', ...args)
        } catch (err) {
          /* ignore */
        }
      },
    }

    controller.setPhase('ready')
    try {
      const result = pluginDefault.register(ctx)
      if (result && typeof result.then === 'function') await result
      controller.setPhase('registered')
    } catch (err) {
      controller.fail('register', err)
    }

    return instance
  }

  function dispose() {
    for (const instance of Array.from(instances.values())) {
      try {
        instance.dispose()
      } catch (err) {
        /* ignore */
      }
    }
    instances.clear()
    revokeUrl(reactUrl)
    revokeUrl(jsxUrl)
    reactUrl = null
    jsxUrl = null
  }

  return {
    load,
    dispose,
    rewriteSpecifiers,
    /** Exposed for diagnostics in the client page. */
    get reactGlobal() {
      return REACT_GLOBAL
    },
  }
}
