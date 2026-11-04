/**
 * Browser half of the Hermes Plugin Host bundle.
 *
 * The management surface is one panel; every installed plugin then gets its own
 * first-class Harness panel, exactly like the built-in Plugins page:
 *  - `main` (key `hermes-plugins`) + `sidebar.panellist` (id `hermes-plugins`,
 *    order 30): the Hermes Plugins browse/install/uninstall page. Its per-plugin
 *    action is Open, which selects that plugin's own panel.
 *  - For every installed plugin with `hasDesktop`, one `main` panel and one
 *    `sidebar.panellist` entry with id/key `hermes:<name>` (orders 40, 41, ...),
 *    labelled with the plugin's label (e.g. "Office 3D"). A pane is only
 *    registered while the plugin is installed; uninstalling disposes it.
 *
 * A plugin panel lazily mounts its desktop half: `web/runtime.js` and `web/sdk.js`
 * are plain ESM fetched from the Host as text (cached once per app), imported
 * through blob URLs, and handed to `createHermesRuntime({ React, createSdk, api })`;
 * the page's `api.rest` owns the two-carrier backend transport (see `rest()`),
 * `api.host` owns real Harness navigation (see `makeHostBridge()`). The Root is a
 * normal React component, so it renders inside the panel with the Harness theme
 * (no iframe). Each panel owns one instance and disposes it on unmount/reload.
 *
 * Transport: the Host registers the authenticated `/api/hermes-plugins/*` route
 * first and a same-origin `/hermes-plugins/*` fallback second; this client tries
 * primary, then fallback, and remembers which carrier answered.
 *
 * All visible strings are English constants in TEXT below — this build has no
 * verified Client locale service contract to route them through.
 */
window.__ModuleLoader__.load({
  id: '@local/hermes-plugin-host',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    /* ------------------------------------------------------------------ */
    /* Constants                                                           */
    /* ------------------------------------------------------------------ */

    const PANEL_ID = 'hermes-plugins'
    const ENTRY_ID = 'hermes-plugins'
    const LIST_POLL_MS = 15000

    const TEXT = {
      title: 'Hermes Plugins',
      subtitle: 'Install, enable and run Hermes Desktop plugins',
      addPlugin: 'Add plugin',
      addMenuLabel: 'Add a plugin',
      addMenuLocal: 'From local directory…',
      addMenuGit: 'From git URL…',
      install: 'Install',
      installing: 'Installing…',
      installPlaceholderPath: '/absolute/path/to/hermes-plugin',
      installPlaceholderGit: 'https://github.com/owner/hermes-plugin or git+https://…',
      refresh: 'Refresh',
      tabsLabel: 'Plugin views',
      tabInstalled: 'Installed',
      tabFound: 'Found in Hermes',
      sectionInstalled: 'Installed plugins',
      sectionAgentOnly: 'Agent-only plugins',
      sectionFound: 'Found in Hermes',
      foundHint: 'Read-only scan of ~/.hermes/plugins. Installing copies the plugin into the Host store.',
      emptyInstalled: 'No Hermes plugins installed yet.',
      emptyInstalledHint: 'Use “Add plugin” to install one from a local directory or a git URL.',
      emptyFound: 'Nothing found in ~/.hermes/plugins.',
      loading: 'Loading installed plugins…',
      noDescription: 'No description in plugin.yaml.',
      noDesktop: 'This plugin has no desktop half, so it has no panel to open.',
      noUi: 'No UI',
      noInstall: 'Agent-only plugin',
      open: 'Open',
      confirmRemove: 'Confirm remove',
      cancel: 'Cancel',
      removeBusy: 'Removing…',
      dismiss: 'Dismiss',
      retry: 'Retry',
      tryAgain: 'Try again',
      installFailed: 'Install failed.',
      removeFailed: 'Uninstall failed.',
      listFailed: 'Could not load the plugin list.',
      loadList: 'Hermes Plugin Host is unreachable.',
      runtimeMissing: 'Plugin runtime assets are missing on the Host (web/runtime.js, web/sdk.js, web/sdk.css). Panels cannot start until they exist.',
      storeLabel: 'Store',
      modeLabel: 'Route',
      unknownError: 'unknown error',
      timeout: 'the request timed out',
      requestFailed: (status) => `request failed (HTTP ${status})`,
      httpStatus: (status) => `HTTP ${status}`,
      unexpectedHtml: (status) => `unexpected HTML response (HTTP ${status})`,
      htmlResponse: 'unexpected HTML response',
      notJson: 'the response was not JSON',
      unexpectedPayload: 'unexpected response payload',
      emptyResponse: 'empty response',
      hostUnknownSession: 'That session is no longer available in DeepSeek Harness.',
      hostUnknownRequest: (method) => `'${method}' is not available in DeepSeek Harness.`,
      backendUnreachable: 'The plugin backend is unreachable.',
      backendFailed: (status) => `Backend request failed (HTTP ${status})`,
      backendNotMounted: (status) => `The plugin backend route is not mounted (HTTP ${status}).`,
      panelLoading: (label) => `Loading ${label}…`,
      panelErrorTitle: 'This plugin panel could not start',
      crash: 'The plugin UI crashed',
      crashHint: 'Its render threw. Use Try again to restart the panel — the rest of the app stays usable.',
      panelMissing: 'This plugin is no longer installed.',
      badges: {
        backend: 'backend',
        tools: (names) => `tools: ${names.join(', ')}`,
        agentOnly: 'agent-only',
        error: 'error',
      },
      titles: {
        backendBadge: 'Has a Python backend half',
        open: 'Open this plugin panel in the sidebar',
        remove: 'Remove this plugin from the store',
        confirmRemove: 'Press again to remove this plugin from the store',
        availableInstall: (name) => `Install ${name} from ~/.hermes/plugins`,
        noDir: 'No directory reported',
        agentOnly: 'Agent-only plugin: it has no desktop half to install or run here.',
      },
      errors: {
        runtimeLoad: (reason) => `Could not load the Hermes runtime: ${reason}`,
        sdkLoad: (reason) => `Could not load the Hermes SDK shim: ${reason}`,
        cssLoad: (reason) => `Could not load the Hermes stylesheet: ${reason}`,
        noRuntimeExport: 'The Hermes runtime module has no createHermesRuntime export.',
        noSdkExport: 'The Hermes SDK shim has no createSdk export.',
        noLoadMethod: 'The Hermes runtime has no load() method.',
        sourceRead: 'Could not read the plugin source.',
        sourceMissing: 'The plugin has no desktop/plugin.js source to run.',
      },
    }

    /* ------------------------------------------------------------------ */
    /* Transport (authenticated /api route first, same-origin fallback)    */
    /* ------------------------------------------------------------------ */

    const PRIMARY_PREFIXES = ['/api/hermes-plugins/', 'api/hermes-plugins/']
    const FALLBACK_PREFIXES = ['/hermes-plugins/', 'hermes-plugins/']
    /** Which carrier answered last, so later calls skip the probe. */
    let routeMode = null

    function modeForPrefix(prefix) {
      return prefix.indexOf('api/') >= 0 ? 'primary' : 'fallback'
    }

    function candidatePrefixes() {
      return routeMode === 'fallback' ? FALLBACK_PREFIXES : PRIMARY_PREFIXES.concat(FALLBACK_PREFIXES)
    }

    function opUrl(prefix, op, query) {
      const suffix = query ? (query.charAt(0) === '?' ? query : `?${query}`) : ''
      return `${prefix}${op}${suffix}`
    }

    function describeError(error) {
      if (!error) return TEXT.unknownError
      if (error.name === 'AbortError') return TEXT.timeout
      return String(error.message || error)
    }

    async function request(prefix, op, options) {
      const opts = options || {}
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs || 20000) : null
      try {
        const headers = { accept: opts.accept || 'application/json' }
        if (opts.body) headers['content-type'] = 'application/json'
        return await fetch(opUrl(prefix, op, opts.query), {
          method: opts.method || 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: controller ? controller.signal : undefined,
        })
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /**
     * JSON operation. A host carrier always answers `{ ok: true, ... }` or
     * `{ ok: false, error }`; an HTML document means this carrier is not
     * mounted, so the next prefix is tried. `{ ok: false }` is a real host
     * answer and is returned immediately.
     */
    async function fetchJson(op, options) {
      const opts = options || {}
      let lastError = null
      /** `{ ok:false }` on 404/405 may just mean this carrier has no such route. */
      let lastHostError = null
      for (const prefix of candidatePrefixes()) {
        try {
          const response = await request(prefix, op, opts)
          const type = String(response.headers.get('content-type') || '').toLowerCase()
          if (type.indexOf('text/html') >= 0) {
            lastError = new Error(TEXT.unexpectedHtml(response.status))
            continue
          }
          let payload = null
          try {
            payload = await response.json()
          } catch {
            lastError = new Error(TEXT.notJson)
            continue
          }
          if (!payload || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
            lastError = new Error(TEXT.unexpectedPayload)
            continue
          }
          if (payload.ok === false) {
            const message = String(payload.error || TEXT.requestFailed(response.status))
            if (response.status === 404 || response.status === 405) {
              lastHostError = message
              lastError = new Error(message)
              continue
            }
            routeMode = modeForPrefix(prefix)
            return { ok: false, error: message }
          }
          routeMode = modeForPrefix(prefix)
          return payload
        } catch (error) {
          lastError = error
        }
      }
      if (lastHostError) return { ok: false, error: lastHostError }
      return { ok: false, error: `${TEXT.loadList} ${describeError(lastError)}` }
    }

    /** Text operation (`module?name=...`): raw JavaScript or CSS. */
    async function fetchText(op, query, timeoutMs) {
      let lastError = null
      for (const prefix of candidatePrefixes()) {
        try {
          const response = await request(prefix, op, { query, accept: 'text/plain', timeoutMs })
          const text = await response.text()
          if (!response.ok) {
            let message = TEXT.httpStatus(response.status)
            try {
              const payload = JSON.parse(text)
              if (payload && payload.error) message = String(payload.error)
            } catch (error) {
              /* a non-JSON failure body keeps the status message */
            }
            lastError = new Error(message)
            continue
          }
          if (!text) {
            lastError = new Error(TEXT.emptyResponse)
            continue
          }
          const head = text.slice(0, 160).trim().toLowerCase()
          if (head.indexOf('<!doctype') === 0 || head.indexOf('<html') === 0) {
            lastError = new Error(TEXT.htmlResponse)
            continue
          }
          routeMode = modeForPrefix(prefix)
          return { ok: true, text }
        } catch (error) {
          lastError = error
        }
      }
      return { ok: false, error: describeError(lastError) }
    }

    /* ------------------------------------------------------------------ */
    /* Backend transport handed to the Hermes runtime (`api.rest`)         */
    /* ------------------------------------------------------------------ */

    /** `subPath` is the plugin's own API path (`/state`), optionally with a query. */
    function splitPluginPath(subPath) {
      const raw = typeof subPath === 'string' ? subPath : String(subPath == null ? '' : subPath)
      const withoutHash = raw.indexOf('#') >= 0 ? raw.slice(0, raw.indexOf('#')) : raw
      const queryAt = withoutHash.indexOf('?')
      const pathPart = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash
      const query = queryAt >= 0 ? withoutHash.slice(queryAt + 1) : ''
      return { path: pathPart.charAt(0) === '/' ? pathPart : `/${pathPart}`, query }
    }

    function hasHeader(headers, name) {
      const wanted = String(name).toLowerCase()
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === wanted) return true
      }
      return false
    }

    function backendMessage(payload, status) {
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        if (payload.error) return String(payload.error)
        if (payload.detail) return String(payload.detail)
      }
      return TEXT.backendFailed(status)
    }

    /**
     * One backend call on one carrier.
     *  primary  — authenticated Connection Fetch: one exact route
     *             `/api/hermes-plugins/backend`, name/path/method as parameters
     *             (GET query string; POST JSON envelope with the plugin body).
     *  fallback — same-origin Web prefix: `/hermes-plugins/backend/<plugin><path>`
     *             with the real HTTP method.
     * The plugin's status, content-type and body are passed straight through.
     */
    async function sendBackend(carrier, pluginName, subPath, init) {
      const { path, query } = splitPluginPath(subPath)
      const settings = init && typeof init === 'object' ? init : {}
      const method = String(settings.method || 'GET').toUpperCase()
      const headers = Object.assign({ accept: 'application/json' }, settings.headers || {})
      const plugin = encodeURIComponent(String(pluginName))
      const extra = query ? `&${query}` : ''
      const isForm = typeof FormData !== 'undefined' && settings.body instanceof FormData
      const isRaw = isForm || typeof settings.body === 'string'
      const hasBody = settings.body !== undefined && settings.body !== null
      const fallbackUrl = `/hermes-plugins/backend/${plugin}${path}${query ? `?${query}` : ''}`
      let url
      let body

      if (carrier === 'primary') {
        if (method === 'GET' || method === 'HEAD') {
          url = `/api/hermes-plugins/backend?name=${plugin}&path=${encodeURIComponent(path)}&method=${method}${extra}`
          if (hasBody) throw new Error(`${method} backend calls do not carry a body.`)
        } else if (isRaw) {
          // A string/FormData body cannot live inside the JSON envelope; the
          // fallback carrier forwards it verbatim and is always registered too.
          url = fallbackUrl
          if (hasBody) body = settings.body
        } else {
          // Host shape: POST /api/hermes-plugins/backend with the JSON envelope;
          // the method travels in the envelope, not the query.
          url = `/api/hermes-plugins/backend${query ? `?${query}` : ''}`
          if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json'
          body = JSON.stringify({
            name: String(pluginName),
            path,
            method,
            body: hasBody ? settings.body : null,
          })
        }
      } else {
        url = fallbackUrl
        if (hasBody) {
          if (isRaw) body = settings.body
          else {
            body = JSON.stringify(settings.body)
            if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json'
          }
        }
      }

      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), settings.timeoutMs || 45000) : null
      try {
        const fetchInit = { method, credentials: 'same-origin', cache: 'no-store', headers }
        const signal = settings.signal || (controller ? controller.signal : undefined)
        if (signal) fetchInit.signal = signal
        if (body !== undefined) fetchInit.body = body
        const response = await fetch(url, fetchInit)
        const type = String(response.headers.get('content-type') || '').toLowerCase()
        if (type.indexOf('text/html') >= 0) {
          const carrierError = new Error(TEXT.backendNotMounted(response.status))
          carrierError.carrierFailure = true
          throw carrierError
        }
        const text = await response.text()
        let payload = null
        if (text) {
          try {
            payload = JSON.parse(text)
          } catch (parseError) {
            payload = text
          }
        }
        if (!response.ok) {
          const failure = new Error(backendMessage(payload, response.status))
          failure.pluginError = true
          throw failure
        }
        // A bare array (office-3d /state) is returned untouched; only an explicit
        // `{ ok:false, error }` control envelope counts as a failure.
        if (!Array.isArray(payload) && payload && typeof payload === 'object' && payload.ok === false) {
          const failure = new Error(backendMessage(payload, response.status))
          failure.pluginError = true
          throw failure
        }
        return payload
      } catch (error) {
        if (error && (error.pluginError || error.name === 'AbortError' || error.carrierFailure)) throw error
        error.carrierFailure = true
        throw error
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /**
     * `api.rest(pluginName, subPath, init)` for the Hermes runtime. Returns the
     * plugin's parsed JSON raw (arrays are not wrapped) and throws on a non-2xx
     * or `{ ok:false, error }` answer so the plugin's useQuery shows ErrorState.
     */
    async function rest(pluginName, subPath, init) {
      const carriers = routeMode === 'fallback' ? ['fallback'] : ['primary', 'fallback']
      let lastError = null
      for (const carrier of carriers) {
        try {
          const payload = await sendBackend(carrier, pluginName, subPath, init)
          routeMode = carrier
          return payload
        } catch (error) {
          if (error && (error.pluginError || error.name === 'AbortError')) throw error
          lastError = error
        }
      }
      if (lastError && lastError.message) throw lastError
      throw new Error(TEXT.backendUnreachable)
    }

    /* ------------------------------------------------------------------ */
    /* Session snapshot bridge (slot standardProps -> host bridge)          */
    /* ------------------------------------------------------------------ */

    /**
     * Latest `useSessions` snapshot from the `main` slot's standard props.
     * The page keeps its own `useRef` and registers it here once mounted; the
     * host bridge (created in `apply`) reads it synchronously when a Run starts.
     */
    let sessionSnapshotRef = null

    function sessionStamp(value) {
      const stamp =
        value.updatedAt !== undefined
          ? value.updatedAt
          : value.time !== undefined
            ? value.time
            : value.createdAt !== undefined
              ? value.createdAt
              : value.updated_at !== undefined
                ? value.updated_at
                : value.updatedAtMs !== undefined
                  ? value.updatedAtMs
                  : 0
      if (typeof stamp === 'string') return Date.parse(stamp) || 0
      const numeric = Number(stamp)
      return Number.isFinite(numeric) ? numeric : 0
    }

    /**
     * Tolerate every plausible `useSessions` snapshot shape:
     *   - `{ ids: string[], byId: Record<id, summary> }`
     *   - `{ sessions: [...] }`
     *   - a plain array of summaries
     * Each entry becomes `{ id, title, updatedAt }`.
     */
    function normalizeSessionSnapshot(snapshot) {
      const entries = []
      const push = (value, fallbackId) => {
        if (value == null) return
        if (typeof value === 'string') {
          entries.push({ id: value, title: '', updatedAt: 0 })
          return
        }
        if (typeof value !== 'object') return
        const rawId = value.sessionId || value.id || value.session_id || fallbackId
        if (!rawId) return
        entries.push({
          id: String(rawId),
          title:
            typeof value.title === 'string' ? value.title : typeof value.name === 'string' ? value.name : '',
          updatedAt: sessionStamp(value),
        })
      }

      if (Array.isArray(snapshot)) {
        for (const item of snapshot) push(item)
        return entries
      }
      if (!snapshot || typeof snapshot !== 'object') return entries
      if (Array.isArray(snapshot.sessions)) {
        for (const item of snapshot.sessions) push(item)
        return entries
      }
      if (snapshot.byId && typeof snapshot.byId === 'object') {
        const ids = Array.isArray(snapshot.ids) ? snapshot.ids : Object.keys(snapshot.byId)
        for (const id of ids) push(snapshot.byId[id], id)
        return entries
      }
      if (Array.isArray(snapshot.ids)) {
        for (const id of snapshot.ids) push(id)
        return entries
      }
      return entries
    }

    function readSessionEntries() {
      try {
        return normalizeSessionSnapshot(sessionSnapshotRef && sessionSnapshotRef.current)
      } catch (error) {
        return []
      }
    }

    /* ------------------------------------------------------------------ */
    /* Hermes runtime loading                                              */
    /* ------------------------------------------------------------------ */

    /** The one `<style data-hermes-sdk>` element for the plugin's utility CSS. */
    let sdkStyleElement = null

    function installSdkStyle(css) {
      try {
        if (typeof document === 'undefined') return
        if (!sdkStyleElement) {
          sdkStyleElement = document.createElement('style')
          sdkStyleElement.setAttribute('data-hermes-sdk', '')
          document.head.appendChild(sdkStyleElement)
        }
        sdkStyleElement.textContent = css
      } catch (error) {
        /* A missing head is not worth blanking the page over. */
      }
    }

    function removeSdkStyle() {
      try {
        if (sdkStyleElement && sdkStyleElement.parentNode) sdkStyleElement.parentNode.removeChild(sdkStyleElement)
      } catch (error) {
        /* ignore */
      }
      sdkStyleElement = null
    }

    function importBlob(source) {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      const pending = import(url)
      return pending.then(
        (moduleValue) => {
          URL.revokeObjectURL(url)
          return moduleValue
        },
        (error) => {
          URL.revokeObjectURL(url)
          throw error
        },
      )
    }

    /**
     * Fetch runtime + sdk + sdk.css once per app and memoise the module pair.
     * Every plugin panel shares it; a failure clears the cache so a panel's
     * retry button can try again.
     */
    let runtimeModulesPromise = null

    async function loadRuntimeModulesUncached() {
      const [runtimeText, sdkText, css] = await Promise.all([
        fetchText('module', 'name=runtime', 30000),
        fetchText('module', 'name=sdk', 30000),
        fetchText('module', 'name=sdk.css', 30000),
      ])
      if (!runtimeText.ok) throw new Error(TEXT.errors.runtimeLoad(runtimeText.error))
      if (!sdkText.ok) throw new Error(TEXT.errors.sdkLoad(sdkText.error))
      if (!css.ok) throw new Error(TEXT.errors.cssLoad(css.error))
      // One sdk stylesheet for the whole app, no matter how many panels mount.
      installSdkStyle(css.text)
      // runtime.js builds its React blob from this global (CONTRACT.md section D).
      window.__dshHermesReact = React
      const [runtimeModule, sdkModule] = await Promise.all([
        importBlob(runtimeText.text),
        importBlob(sdkText.text),
      ])
      if (!runtimeModule || typeof runtimeModule.createHermesRuntime !== 'function') {
        throw new Error(TEXT.errors.noRuntimeExport)
      }
      if (!sdkModule || typeof sdkModule.createSdk !== 'function') {
        throw new Error(TEXT.errors.noSdkExport)
      }
      return { createHermesRuntime: runtimeModule.createHermesRuntime, createSdk: sdkModule.createSdk }
    }

    function loadRuntimeModules() {
      if (!runtimeModulesPromise) {
        runtimeModulesPromise = loadRuntimeModulesUncached().catch((error) => {
          runtimeModulesPromise = null
          throw error
        })
      }
      return runtimeModulesPromise
    }

    async function loadPluginSource(name) {
      const payload = await fetchJson('source', { query: `name=${encodeURIComponent(name)}` })
      if (!payload.ok) throw new Error(payload.error || TEXT.errors.sourceRead)
      if (typeof payload.source !== 'string' || !payload.source) {
        throw new Error(TEXT.errors.sourceMissing)
      }
      return payload.source
    }

    function disposeInstance(instance) {
      if (!instance) return
      try {
        if (typeof instance.dispose === 'function') instance.dispose()
      } catch (error) {
        /* A failing dispose must not break the page. */
      }
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    const ICONS = {
      plugins: [
        h('path', { key: 'a', d: 'M9 3.5v3M15 3.5v3M6.2 6.5h11.6a1 1 0 0 1 1 1v3.2a6.8 6.8 0 0 1-6.8 6.8 6.8 6.8 0 0 1-6.8-6.8V7.5a1 1 0 0 1 1-1z' }),
        h('path', { key: 'b', d: 'M12 17.5v3' }),
      ],
      play: [h('path', { key: 'a', d: 'M8 5.2l10.5 6.8L8 18.8z' })],
      stop: [h('rect', { key: 'a', x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 })],
      reload: [
        h('path', { key: 'a', d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3' }),
        h('path', { key: 'b', d: 'M19.8 4.5v4.2h-4.2' }),
      ],
      trash: [
        h('path', { key: 'a', d: 'M4.5 7h15' }),
        h('path', { key: 'b', d: 'M9.2 7V5.3A1.3 1.3 0 0 1 10.5 4h3a1.3 1.3 0 0 1 1.3 1.3V7' }),
        h('path', { key: 'c', d: 'M6.6 7l.8 11.2A1.6 1.6 0 0 0 9 19.8h6a1.6 1.6 0 0 0 1.6-1.6L17.4 7' }),
      ],
      plus: [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })],
      open: [
        h('path', { key: 'a', d: 'M13.5 4.5h6v6' }),
        h('path', { key: 'b', d: 'M19.5 4.5L11.5 12.5' }),
        h('path', { key: 'c', d: 'M19 14.2v3.6a1.2 1.2 0 0 1-1.2 1.2H5.7a1.2 1.2 0 0 1-1.2-1.2V5.7a1.2 1.2 0 0 1 1.2-1.2h3.6' }),
      ],
      chevron: [h('path', { key: 'a', d: 'M7 10l5 5 5-5' })],
      folder: [h('path', { key: 'a', d: 'M4 7.5A1.5 1.5 0 0 1 5.5 6h4l2 2h7A1.5 1.5 0 0 1 20 9.5v8A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z' })],
      git: [
        h('circle', { key: 'a', cx: 6.5, cy: 6, r: 2.2 }),
        h('circle', { key: 'b', cx: 6.5, cy: 18, r: 2.2 }),
        h('circle', { key: 'c', cx: 17.5, cy: 9, r: 2.2 }),
        h('path', { key: 'd', d: 'M6.5 8.2v7.6M17.5 11.2c0 3-2.4 4.2-5 4.6-2 .3-4 .9-4.8 2.2' }),
      ],
      alert: [
        h('path', { key: 'a', d: 'M12 4.5l8.2 14.2a1.2 1.2 0 0 1-1 1.8H4.8a1.2 1.2 0 0 1-1-1.8z' }),
        h('path', { key: 'b', d: 'M12 9.6v4.2M12 17.2v.2' }),
      ],
    }

    function Icon(props) {
      const size = props.size || 14
      const shapes = ICONS[props.name] || ICONS.plugins
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.strokeWidth || 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        shapes,
      )
    }

    /* ------------------------------------------------------------------ */
    /* CSS (only --dsw-alias-* tokens; .hpx- prefixed classes)             */
    /* ------------------------------------------------------------------ */

    const CSS = `
.hpx-page{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;overflow-y:auto;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;line-height:1.45}
.hpx-page *{box-sizing:border-box}
.hpx-content{width:100%;display:flex;flex-direction:column;padding:40px 40px 48px}
.hpx-head{display:flex;align-items:flex-start;gap:16px;margin:0 0 24px}
.hpx-head-text{min-width:0;display:flex;flex-direction:column;gap:6px}
.hpx-title{font-size:30px;font-weight:600;line-height:1.15;letter-spacing:-.01em;margin:0}
.hpx-subtitle{font-size:14px;font-weight:400;color:var(--dsw-alias-label-secondary);margin:0}
.hpx-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none;padding-top:2px}
.hpx-icon-btn{width:36px;height:36px;border-radius:50%;border:0;background:transparent;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.hpx-icon-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.hpx-split{position:relative;display:inline-flex;align-items:stretch;height:40px;border-radius:10px;
  background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.hpx-split-main{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 14px;border:0;
  border-radius:10px 0 0 10px;background:transparent;color:inherit;font:inherit;font-size:15px;font-weight:600;
  cursor:pointer;white-space:nowrap}
.hpx-split-main:hover{background:color-mix(in srgb, var(--dsw-alias-bg-base) 10%, transparent)}
.hpx-split-caret{display:inline-flex;align-items:center;justify-content:center;width:34px;height:40px;border:0;
  border-left:1px solid color-mix(in srgb, var(--dsw-alias-bg-base) 28%, transparent);
  border-radius:0 10px 10px 0;background:transparent;color:inherit;cursor:pointer}
.hpx-split-caret:hover{background:color-mix(in srgb, var(--dsw-alias-bg-base) 10%, transparent)}
.hpx-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:20;min-width:224px;padding:6px;
  border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.hpx-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border:0;
  border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;
  text-align:left;cursor:pointer}
.hpx-menu-item:hover{background:var(--dsw-alias-bg-layer-1)}
.hpx-seg{display:inline-flex;align-items:center;gap:4px;width:330px;max-width:100%;height:50px;padding:4px;
  margin:0 0 4px;border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.hpx-seg-btn{flex:1 1 auto;height:42px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;font-weight:500;cursor:pointer}
.hpx-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.hpx-seg-btn.is-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.hpx-install-bar{display:flex;align-items:center;gap:8px;margin:14px 0 0;padding:10px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-1)}
.hpx-input{flex:1 1 auto;min-width:0;height:38px;padding:0 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px}
.hpx-input::placeholder{color:var(--dsw-alias-label-secondary)}
.hpx-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:transparent}
.hpx-inline-error{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:13px;
  color:var(--dsw-alias-state-error-primary);line-height:1.4;word-break:break-word}
.hpx-inline-warn{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:13px;
  color:var(--dsw-alias-state-warn-primary);line-height:1.4;word-break:break-word}
.hpx-text-btn{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;
  cursor:pointer;padding:0 2px;text-decoration:underline;text-underline-offset:2px}
.hpx-section{margin-top:40px}
.hpx-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  margin:0 0 8px;min-height:22px}
.hpx-section-title{font-size:16px;font-weight:600;letter-spacing:.005em;margin:0}
.hpx-section-note{font-size:13px;color:var(--dsw-alias-label-secondary)}
.hpx-rows{display:flex;flex-direction:column;gap:24px;margin-top:16px}
.hpx-row{display:flex;align-items:center;gap:16px;width:100%;min-height:96px;padding:10px 12px;
  border-radius:10px;background:transparent;text-align:left}
.hpx-row:hover{background:var(--dsw-alias-bg-layer-1)}
.hpx-row.is-flash{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)}
.hpx-tile{flex:none;width:46px;height:46px;border-radius:11px;display:flex;align-items:center;
  justify-content:center;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.hpx-row-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.hpx-row-title-line{display:flex;align-items:center;gap:8px;min-width:0}
.hpx-row-title{font-size:16px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hpx-badge{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
  font-size:11px;letter-spacing:.02em;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis}
.hpx-badge.is-warn{color:var(--dsw-alias-state-warn-primary);
  border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l1))}
.hpx-badge.is-error{color:var(--dsw-alias-state-error-primary);
  border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1))}
.hpx-row-desc{font-size:14px;font-weight:400;line-height:1.4;color:var(--dsw-alias-label-secondary);margin:0;
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.hpx-row-desc.is-error{color:var(--dsw-alias-state-error-primary)}
.hpx-row-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0}
.hpx-row-tail{flex:none;display:flex;align-items:center;gap:6px}
.hpx-open-btn{height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;
  cursor:pointer;white-space:nowrap}
.hpx-open-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.hpx-open-btn[disabled]{opacity:.45;cursor:default}
.hpx-no-ui{font-size:13px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding:0 4px}
.hpx-ghost-btn{width:32px;height:32px;border-radius:8px;border:0;background:transparent;
  color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.hpx-ghost-btn:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color:var(--dsw-alias-state-error-primary)}
.hpx-confirm-btn{height:32px;padding:0 10px;border-radius:8px;font:inherit;font-size:12.5px;font-weight:500;
  cursor:pointer;white-space:nowrap;background:transparent;color:var(--dsw-alias-state-error-primary);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1))}
.hpx-confirm-btn:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.hpx-cancel-btn{height:32px;padding:0 10px;border-radius:8px;border:0;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}
.hpx-cancel-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.hpx-quiet{display:flex;flex-direction:column;gap:6px;padding:14px 12px;color:var(--dsw-alias-label-secondary);
  font-size:14px;line-height:1.45}
.hpx-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:40px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary)}
.hpx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;max-width:100%}
.hpx-page button:focus-visible,.hpx-page input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:2px}
.hpx-panel-page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.45}
.hpx-panel-page *{box-sizing:border-box}
.hpx-panel-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.hpx-panel-body > .hph-root{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.hpx-panel-state{margin:auto;display:flex;flex-direction:column;align-items:center;gap:9px;max-width:520px;
  padding:18px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center}
.hpx-panel-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);
  border-top-color:var(--dsw-alias-brand-primary);animation:hpx-spin .8s linear infinite}
@keyframes hpx-spin{to{transform:rotate(360deg)}}
.hpx-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.hpx-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.hpx-btn[disabled]{opacity:.45;cursor:default}
.hpx-btn-tiny{height:24px;font-size:11.5px;padding:0 9px}
.hpx-panel-icon{display:flex}
.hpx-error{display:flex;align-items:flex-start;gap:7px;padding:8px 10px;border-radius:8px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1));
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
  color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.45;word-break:break-word}
.hpx-error-body{display:flex;flex-direction:column;gap:3px;min-width:0}
@media (prefers-reduced-motion:reduce){.hpx-panel-spinner{animation:none}}
`

    function StyleTag() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } })
    }

    /* ------------------------------------------------------------------ */
    /* Error boundary for the plugin's own UI                              */
    /* ------------------------------------------------------------------ */

    class PluginErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        try {
          if (typeof console !== 'undefined' && console.error) console.error('[hermes-plugins] plugin UI crashed', error)
        } catch (ignored) {
          /* ignore */
        }
      }

      render() {
        if (this.state.error) {
          const message = String((this.state.error && this.state.error.message) || this.state.error)
          return h(
            'div',
            { className: 'hpx-error', role: 'alert' },
            h(Icon, { name: 'alert', size: 14 }),
            h(
              'div',
              { className: 'hpx-error-body' },
              h('strong', null, TEXT.crash),
              h('span', null, message),
              h('span', { className: 'hpx-note' }, TEXT.crashHint),
            ),
          )
        }
        return this.props.children
      }
    }

    /* ------------------------------------------------------------------ */
    /* Helpers                                                             */
    /* ------------------------------------------------------------------ */

    function normalizePlugin(raw) {
      if (!raw || typeof raw !== 'object') return null
      const name = typeof raw.name === 'string' && raw.name ? raw.name : null
      if (!name) return null
      return {
        name,
        label: typeof raw.label === 'string' && raw.label ? raw.label : name,
        version: typeof raw.version === 'string' && raw.version ? raw.version : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        author: typeof raw.author === 'string' ? raw.author : '',
        license: typeof raw.license === 'string' ? raw.license : '',
        kind: typeof raw.kind === 'string' ? raw.kind : '',
        platforms: Array.isArray(raw.platforms) ? raw.platforms.filter((entry) => typeof entry === 'string') : [],
        providesTools: Array.isArray(raw.providesTools)
          ? raw.providesTools.filter((entry) => typeof entry === 'string')
          : Array.isArray(raw.provides_tools)
            ? raw.provides_tools.filter((entry) => typeof entry === 'string')
            : [],
        dir: typeof raw.dir === 'string' ? raw.dir : '',
        hasDesktop: raw.hasDesktop === true,
        hasBackend: raw.hasBackend === true,
        backendApi: typeof raw.backendApi === 'string' ? raw.backendApi : '',
        installedAt: Number.isFinite(raw.installedAt) ? raw.installedAt : 0,
        source: typeof raw.source === 'string' ? raw.source : '',
        warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((entry) => typeof entry === 'string') : [],
        error: typeof raw.error === 'string' && raw.error ? raw.error : null,
      }
    }

    /** `available` entries are the Host's read-only ~/.hermes/plugins scan. */
    function normalizeAvailable(payload) {
      const raw = payload && (Array.isArray(payload.available) ? payload.available : Array.isArray(payload.availablePlugins) ? payload.availablePlugins : null)
      if (!raw) return []
      const seen = new Set()
      const result = []
      for (const entry of raw) {
        const record = typeof entry === 'string' ? { name: entry } : entry && typeof entry === 'object' ? entry : null
        if (!record) continue
        const name = String(record.name || record.label || '')
        if (!name || seen.has(name)) continue
        seen.add(name)
        result.push({
          name,
          label: typeof record.label === 'string' && record.label ? record.label : name,
          version: typeof record.version === 'string' ? record.version : '',
          dir: typeof record.dir === 'string' ? record.dir : typeof record.path === 'string' ? record.path : '',
          hasDesktop: record.hasDesktop === true,
          hasBackend: record.hasBackend === true,
          installable: record.installable !== false,
          installed: record.installed === true,
        })
      }
      return result.filter((entry) => !entry.installed)
    }

    /** Async run/uninstall guard shared by the page and by `apply` teardown. */
    function markBusy(setter, name, kind) {
      setter((previous) => Object.assign({}, previous, { [name]: kind }))
    }

    function clearBusy(setter, name) {
      setter((previous) => {
        const next = Object.assign({}, previous)
        delete next[name]
        return next
      })
    }

    /* ------------------------------------------------------------------ */
    /* Sidebar icons                                                      */
    /* ------------------------------------------------------------------ */

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      const onOpen = props && typeof props.open === 'function' ? props.open : undefined
      return h(
        'span',
        { className: 'hpx-panel-icon', onClick: onOpen, style: { display: 'flex' } },
        h(Icon, { name: 'plugins', size, strokeWidth: props && props.active ? 1.9 : 1.6 }),
      )
    }

    /** Stable hue per plugin name so several panels read apart in the sidebar. */
    function hashHue(name) {
      const text = String(name == null ? '' : name)
      let hash = 0
      for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0
      }
      return hash % 360
    }

    function PluginIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18
      const name = String((props && props.name) || '')
      const onOpen = props && typeof props.open === 'function' ? props.open : undefined
      return h(
        'span',
        {
          className: 'hpx-panel-icon',
          onClick: onOpen,
          style: { display: 'flex', color: `hsl(${hashHue(name)} 62% 52%)` },
        },
        h(Icon, { name: 'plugins', size, strokeWidth: props && props.active ? 1.9 : 1.6 }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Installed-plugin store (single source of truth)                     */
    /* ------------------------------------------------------------------ */

    function emptyListSnapshot() {
      return {
        status: 'idle',
        plugins: [],
        available: [],
        store: null,
        hermesHome: null,
        hermesPluginsDir: null,
        webAssets: true,
        error: null,
      }
    }

    /**
     * Tiny atom shared by the management page and the panel registrations.
     * `refresh()` dedupes concurrent calls; listeners are synchronous.
     */
    function createPluginStore() {
      let snapshot = emptyListSnapshot()
      let inFlight = null
      const listeners = new Set()

      const notify = () => {
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            /* a listener must not break the store */
          }
        }
      }
      const setSnapshot = (next) => {
        snapshot = next
        notify()
      }

      async function refresh() {
        if (inFlight) return inFlight
        inFlight = (async () => {
          const payload = await fetchJson('list')
          if (!payload.ok) {
            const previous = snapshot
            setSnapshot(Object.assign({}, previous, {
              status: previous.plugins.length ? 'stale' : 'error',
              error: payload.error,
            }))
            return snapshot
          }
          const plugins = Array.isArray(payload.plugins) ? payload.plugins.map(normalizePlugin).filter(Boolean) : []
          setSnapshot({
            status: 'online',
            plugins,
            available: normalizeAvailable(payload),
            store: typeof payload.store === 'string' ? payload.store : null,
            hermesHome: typeof payload.hermesHome === 'string' ? payload.hermesHome : null,
            hermesPluginsDir: typeof payload.hermesPluginsDir === 'string' ? payload.hermesPluginsDir : null,
            webAssets: payload.webAssets !== false,
            error: null,
          })
          return snapshot
        })()
          .catch((error) => {
            setSnapshot(Object.assign({}, snapshot, {
              status: snapshot.plugins.length ? 'stale' : 'error',
              error: String((error && error.message) || error),
            }))
            return snapshot
          })
          .finally(() => {
            inFlight = null
          })
        return inFlight
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        refresh,
      }
    }

    const pluginStore = createPluginStore()

    function storeGetPlugin(name) {
      const plugins = pluginStore.getSnapshot().plugins
      for (const plugin of plugins) {
        if (plugin.name === name) return plugin
      }
      return null
    }

    /* ------------------------------------------------------------------ */
    /* Panel registration diffing                                         */
    /* ------------------------------------------------------------------ */

    /** Panel id == sidebar id == key of the matching `main` registration. */
    function panelIdFor(name) {
      return `hermes:${String(name == null ? '' : name)}`
    }

    function desiredPanels(snapshot) {
      const plugins = snapshot && Array.isArray(snapshot.plugins) ? snapshot.plugins : []
      const result = []
      let index = 0
      for (const plugin of plugins) {
        if (!plugin || plugin.hasDesktop !== true) continue
        result.push({
          id: panelIdFor(plugin.name),
          name: plugin.name,
          label: plugin.label || plugin.name,
          order: 40 + index,
        })
        index += 1
      }
      return result
    }

    /** Add/remove `main` registrations so they mirror the installed list. */
    function syncMainPanels(registered, desired, register) {
      const wanted = new Set(desired.map((item) => item.id))
      for (const [id, entry] of Array.from(registered)) {
        if (wanted.has(id)) continue
        try {
          entry.disposer()
        } catch (error) {
          /* ignore */
        }
        registered.delete(id)
      }
      for (const item of desired) {
        if (registered.has(item.id)) continue
        registered.set(item.id, { disposer: register(item) })
      }
    }

    /** Add/remove/reorder sidebar entries; re-registers on label/order change. */
    function syncSidebarPanels(registered, desired, register) {
      const wanted = new Map(desired.map((item) => [item.id, item]))
      for (const [id, entry] of Array.from(registered)) {
        const item = wanted.get(id)
        if (!item) {
          try {
            entry.disposer()
          } catch (error) {
            /* ignore */
          }
          registered.delete(id)
          continue
        }
        if (entry.label !== item.label || entry.order !== item.order) {
          try {
            entry.disposer()
          } catch (error) {
            /* ignore */
          }
          registered.delete(id)
        }
      }
      for (const item of desired) {
        if (registered.has(item.id)) continue
        registered.set(item.id, {
          disposer: register(item),
          label: item.label,
          order: item.order,
        })
      }
    }

    /* ------------------------------------------------------------------ */
    /* Host bridge + session snapshot (plugin navigation)                  */
    /* ------------------------------------------------------------------ */

    function apiBaseFor() {
      return routeMode === 'fallback' ? '/hermes-plugins' : '/api/hermes-plugins'
    }

    function useSessionBridgeRef(props) {
      const ref = useRef(null)
      let snapshot = null
      try {
        snapshot = props && typeof props.useSessions === 'function' ? props.useSessions() : null
      } catch (error) {
        snapshot = null
      }
      ref.current = snapshot
      useEffect(() => {
        sessionSnapshotRef = ref
        return () => {
          if (sessionSnapshotRef === ref) sessionSnapshotRef = null
        }
      }, [])
    }

    /**
     * `api.host` merged over the runtime's built-in host. Members we can serve
     * are supplied; anything omitted keeps the runtime's own fallback (a single
     * warn toast), so a profile without `uiWorkspace` still works.
     */
    function makeHostBridge(uiWorkspace) {
      const hostBridge = {}
      if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
        hostBridge.newChat = () => {
          uiWorkspace.startSession()
          return Promise.resolve()
        }
      }
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        hostBridge.openSession = (sessionId) => {
          const target = String(sessionId == null ? '' : sessionId)
          const known = readSessionEntries().some((entry) => entry.id === target)
          if (!known) throw new Error(TEXT.hostUnknownSession)
          uiWorkspace.openSession(sessionId)
        }
      }
      hostBridge.request = (method, params) => {
        if (method === 'session.list') {
          const entries = readSessionEntries().slice().sort((a, b) => b.updatedAt - a.updatedAt)
          const requested = params && params.limit
          const limit = Number.isFinite(Number(requested)) && Number(requested) > 0 ? Math.floor(Number(requested)) : 0
          const chosen = limit ? entries.slice(0, limit) : entries
          return Promise.resolve({
            sessions: chosen.map((entry) => ({
              session_id: entry.id,
              id: entry.id,
              title: entry.title,
              updated_at: entry.updatedAt,
            })),
          })
        }
        throw new Error(TEXT.hostUnknownRequest(method))
      }
      return hostBridge
    }

    /* ------------------------------------------------------------------ */
    /* One lazy panel per installed plugin                                 */
    /* ------------------------------------------------------------------ */

    /**
     * Mounts a plugin's desktop half only when its `main` panel is selected.
     * Owns exactly one runtime instance: the lifecycle effect below loads the
     * source and disposes that instance on unmount or reload.
     */
    function PluginPanelHost(props) {
      const pluginName = String((props && props.pluginName) || '')
      const hostBridge = props && props.hostBridge ? props.hostBridge : {}
      useSessionBridgeRef(props)
      const [reloadToken, setReloadToken] = useState(0)
      const [state, setState] = useState({ phase: 'loading', instance: null, error: null })

      useEffect(() => {
        let cancelled = false
        let loadedInstance = null
        setState({ phase: 'loading', instance: null, error: null })
        ;(async () => {
          try {
            const plugin = storeGetPlugin(pluginName)
            if (!plugin) throw new Error(TEXT.panelMissing)
            const modules = await loadRuntimeModules()
            const sourceText = await loadPluginSource(pluginName)
            if (cancelled) return
            const runtime = modules.createHermesRuntime({
              React,
              createSdk: modules.createSdk,
              api: { rest, host: hostBridge },
              apiBase: apiBaseFor(),
            })
            if (!runtime || typeof runtime.load !== 'function') throw new Error(TEXT.errors.noLoadMethod)
            loadedInstance = await runtime.load(plugin, sourceText)
            if (cancelled) {
              disposeInstance(loadedInstance)
              loadedInstance = null
              return
            }
            setState({ phase: 'ready', instance: loadedInstance, error: null })
          } catch (error) {
            if (!cancelled) {
              setState({ phase: 'error', instance: null, error: String((error && error.message) || error) })
            }
          }
        })()
        return () => {
          cancelled = true
          disposeInstance(loadedInstance)
          loadedInstance = null
        }
      }, [pluginName, reloadToken, hostBridge])

      const plugin = storeGetPlugin(pluginName)
      const label = plugin ? plugin.label : pluginName

      let body = null
      if (state.phase === 'ready' && state.instance) {
        body = h(
          'div',
          { className: 'hpx-panel-body' },
          h(
            PluginErrorBoundary,
            { key: `${pluginName}:${reloadToken}` },
            h('div', { className: 'hph-root' }, h(state.instance.Root)),
          ),
        )
      } else if (state.phase === 'error') {
        body = h(
          'div',
          { className: 'hpx-panel-state' },
          h(
            'div',
            { className: 'hpx-error', role: 'alert' },
            h(Icon, { name: 'alert', size: 14 }),
            h(
              'div',
              { className: 'hpx-error-body' },
              h('strong', null, TEXT.panelErrorTitle),
              h('span', null, state.error),
            ),
          ),
          h(
            'button',
            { className: 'hpx-btn hpx-btn-tiny', onClick: () => setReloadToken((value) => value + 1) },
            TEXT.tryAgain,
          ),
        )
      } else {
        body = h(
          'div',
          { className: 'hpx-panel-state' },
          h('span', { className: 'hpx-panel-spinner', 'aria-hidden': true }),
          TEXT.panelLoading(label),
        )
      }

      return h('div', { className: 'hpx-panel-page' }, h(StyleTag), body)
    }

    /* ------------------------------------------------------------------ */

    function HermesPluginsPage(props) {
      const store = (props && props.store) || pluginStore
      const openPanel = props && typeof props.openPanel === 'function' ? props.openPanel : null
      const [list, setList] = useState(() => store.getSnapshot())
      const [installSource, setInstallSource] = useState('')
      const [installing, setInstalling] = useState(false)
      const [installError, setInstallError] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [busy, setBusy] = useState({})
      const [confirmRemove, setConfirmRemove] = useState(null)
      const [flash, setFlash] = useState(null)
      const [tab, setTab] = useState('installed')
      const [installOpen, setInstallOpen] = useState(false)
      const [installMode, setInstallMode] = useState('path')
      const [menuOpen, setMenuOpen] = useState(false)
      const mountedRef = useRef(true)
      const inputRef = useRef(null)
      const menuRef = useRef(null)
      const caretRef = useRef(null)

      /* Subscribe to the shared store and keep it fresh while this page is open
         (mount, window focus, and every 15 s). Panels keep their own
         registrations independent of this page being mounted. */
      useEffect(() => {
        mountedRef.current = true
        let unsubscribe = null
        try {
          unsubscribe = store.subscribe(() => {
            if (mountedRef.current) setList(store.getSnapshot())
          })
        } catch (error) {
          unsubscribe = null
        }
        store.refresh()
        const timer = setInterval(() => {
          try {
            if (typeof document !== 'undefined' && document.hidden) return
          } catch (error) {
            return
          }
          store.refresh()
        }, LIST_POLL_MS)
        let onFocus = null
        try {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            onFocus = () => store.refresh()
            window.addEventListener('focus', onFocus)
          }
        } catch (error) {
          onFocus = null
        }
        return () => {
          mountedRef.current = false
          clearInterval(timer)
          if (unsubscribe) unsubscribe()
          if (onFocus) {
            try {
              window.removeEventListener('focus', onFocus)
            } catch (error) {
              /* ignore */
            }
          }
        }
      }, [store])

      /* Focus the install field as soon as the inline bar opens. */
      useEffect(() => {
        if (!installOpen) return undefined
        const timer = setTimeout(() => {
          try {
            if (inputRef.current && typeof inputRef.current.focus === 'function') inputRef.current.focus()
          } catch (error) {
            /* ignore */
          }
        }, 0)
        return () => clearTimeout(timer)
      }, [installOpen, installMode])

      /* Close the split-button menu on outside click or Escape. */
      useEffect(() => {
        if (!menuOpen) return undefined
        const onPointerDown = (event) => {
          try {
            if (menuRef.current && menuRef.current.contains(event.target)) return
            setMenuOpen(false)
          } catch (error) {
            setMenuOpen(false)
          }
        }
        const onKeyDown = (event) => {
          if (!event || event.key !== 'Escape') return
          setMenuOpen(false)
          try {
            if (caretRef.current && typeof caretRef.current.focus === 'function') caretRef.current.focus()
          } catch (error) {
            /* ignore */
          }
        }
        try {
          document.addEventListener('mousedown', onPointerDown)
          document.addEventListener('keydown', onKeyDown)
        } catch (error) {
          return undefined
        }
        return () => {
          try {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown)
          } catch (error) {
            /* ignore */
          }
        }
      }, [menuOpen])

      /* Flash the freshly installed row, then stop. */
      useEffect(() => {
        if (!flash) return undefined
        const timer = setTimeout(() => setFlash(null), 4000)
        return () => clearTimeout(timer)
      }, [flash])

      /* Expire a pending uninstall confirmation. */
      useEffect(() => {
        if (!confirmRemove) return undefined
        const timer = setTimeout(() => setConfirmRemove(null), 6000)
        return () => clearTimeout(timer)
      }, [confirmRemove])

      const submitInstall = useCallback(
        async (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
          const source = String(installSource || '').trim()
          if (!source || installing) return
          setInstalling(true)
          setInstallError(null)
          try {
            const payload = await fetchJson('install', { method: 'POST', body: { source }, timeoutMs: 180000 })
            if (!payload.ok) {
              if (mountedRef.current) setInstallError(payload.error || TEXT.installFailed)
              return
            }
            if (!mountedRef.current) return
            setInstallSource('')
            setInstallOpen(false)
            if (payload.plugin && payload.plugin.name) setFlash(String(payload.plugin.name))
            await store.refresh()
          } catch (error) {
            if (mountedRef.current) setInstallError(String((error && error.message) || error))
          } finally {
            if (mountedRef.current) setInstalling(false)
          }
        },
        [installSource, installing, store],
      )

      const removePlugin = useCallback(
        async (plugin) => {
          setConfirmRemove(null)
          setActionError(null)
          markBusy(setBusy, plugin.name, 'remove')
          try {
            const payload = await fetchJson('remove', { method: 'POST', body: { name: plugin.name }, timeoutMs: 60000 })
            if (!payload.ok) {
              if (mountedRef.current) setActionError(payload.error || TEXT.removeFailed)
              return
            }
            if (!mountedRef.current) return
            await store.refresh()
          } catch (error) {
            if (mountedRef.current) setActionError(String((error && error.message) || error))
          } finally {
            if (mountedRef.current) clearBusy(setBusy, plugin.name)
          }
        },
        [store],
      )

      const installFound = useCallback(
        (entry) => {
          const key = `available:${entry.name}`
          if (!entry.dir) return
          markBusy(setBusy, key, 'install')
          fetchJson('install', { method: 'POST', body: { source: entry.dir }, timeoutMs: 180000 })
            .then((payload) => {
              if (!mountedRef.current) return
              if (!payload.ok) {
                setInstallError(payload.error || TEXT.installFailed)
                return
              }
              if (payload.plugin && payload.plugin.name) setFlash(String(payload.plugin.name))
              return store.refresh()
            })
            .catch((error) => {
              if (mountedRef.current) setInstallError(String((error && error.message) || error))
            })
            .finally(() => {
              if (mountedRef.current) clearBusy(setBusy, key)
            })
        },
        [store],
      )

      const openPlugin = useCallback(
        (plugin) => {
          if (!openPanel || !plugin || plugin.hasDesktop !== true) return
          openPanel(panelIdFor(plugin.name))
        },
        [openPanel],
      )

      const openInstallForm = useCallback((mode) => {
        setInstallMode(mode)
        setInstallOpen(true)
        setMenuOpen(false)
      }, [])

      const plugins = list.plugins
      const desktopPlugins = plugins.filter((plugin) => plugin.hasDesktop === true)
      const agentPlugins = plugins.filter((plugin) => plugin.hasDesktop !== true)
      const loading = list.status === 'idle' || list.status === 'loading'
      const assetsReady = list.webAssets !== false

      const renderTile = (name) => {
        const hue = hashHue(name)
        return h(
          'span',
          {
            className: 'hpx-tile',
            style: {
              background: `color-mix(in srgb, hsl(${hue} 62% 52%) 14%, var(--dsw-alias-bg-layer-1))`,
              color: `hsl(${hue} 62% 52%)`,
            },
          },
          h(Icon, { name: 'plugins', size: 22 }),
        )
      }

      const renderPills = (plugin) => {
        const items = []
        if (plugin.version) items.push({ key: 'version', label: `v${plugin.version}` })
        for (const warning of plugin.warnings) {
          items.push({ key: `warning:${warning}`, label: warning, className: 'hpx-badge is-warn', title: warning })
        }
        if (plugin.hasBackend) {
          items.push({
            key: 'backend',
            label: TEXT.badges.backend,
            title: plugin.backendApi ? `dashboard/${plugin.backendApi}` : TEXT.titles.backendBadge,
          })
        }
        if (plugin.providesTools.length) items.push({ key: 'tools', label: TEXT.badges.tools(plugin.providesTools) })
        if (plugin.error) items.push({ key: 'error', label: TEXT.badges.error, className: 'hpx-badge is-error' })
        const shown = items.slice(0, 3)
        const hidden = items.length - shown.length
        const nodes = shown.map((item) =>
          h('span', { key: item.key, className: item.className || 'hpx-badge', title: item.title }, item.label),
        )
        if (hidden > 0) {
          nodes.push(h('span', { key: 'more', className: 'hpx-badge', title: items.slice(3).map((item) => item.label).join(' · ') }, `+${hidden}`))
        }
        return nodes
      }

      const renderInstalledRow = (plugin) => {
        const rowBusy = busy[plugin.name] || null
        const confirm = confirmRemove === plugin.name
        const tail = h(
          'div',
          { className: 'hpx-row-tail' },
          plugin.hasDesktop
            ? h(
                'button',
                {
                  className: 'hpx-open-btn',
                  type: 'button',
                  title: TEXT.titles.open,
                  onClick: () => openPlugin(plugin),
                },
                TEXT.open,
              )
            : h('span', { className: 'hpx-no-ui', title: TEXT.noDesktop }, TEXT.noUi),
          confirm
            ? h(
                'span',
                { className: 'hpx-row-tail' },
                h(
                  'button',
                  {
                    className: 'hpx-confirm-btn',
                    type: 'button',
                    disabled: !!rowBusy,
                    title: TEXT.titles.confirmRemove,
                    onClick: () => removePlugin(plugin),
                  },
                  rowBusy === 'remove' ? TEXT.removeBusy : TEXT.confirmRemove,
                ),
                h(
                  'button',
                  {
                    className: 'hpx-cancel-btn',
                    type: 'button',
                    disabled: !!rowBusy,
                    onClick: () => setConfirmRemove(null),
                  },
                  TEXT.cancel,
                ),
              )
            : h(
                'button',
                {
                  className: 'hpx-ghost-btn',
                  type: 'button',
                  disabled: !!rowBusy,
                  title: TEXT.titles.remove,
                  'aria-label': TEXT.titles.remove,
                  onClick: () => setConfirmRemove(plugin.name),
                },
                h(Icon, { name: 'trash', size: 15 }),
              ),
        )
        return h(
          'div',
          { key: plugin.name, className: flash === plugin.name ? 'hpx-row is-flash' : 'hpx-row' },
          renderTile(plugin.name),
          h(
            'div',
            { className: 'hpx-row-main' },
            h(
              'div',
              { className: 'hpx-row-title-line' },
              h('span', { className: 'hpx-row-title', title: plugin.dir || plugin.name }, plugin.label),
              renderPills(plugin),
            ),
            plugin.error
              ? h('p', { className: 'hpx-row-desc is-error' }, plugin.error)
              : h('p', { className: 'hpx-row-desc' }, plugin.description || TEXT.noDescription),
          ),
          tail,
        )
      }

      const renderFoundRow = (entry) => {
        const key = `available:${entry.name}`
        const rowBusy = busy[key] || null
        const tail = h(
          'div',
          { className: 'hpx-row-tail' },
          entry.installable
            ? h(
                'button',
                {
                  className: 'hpx-open-btn',
                  type: 'button',
                  disabled: !entry.dir || !!rowBusy,
                  title: entry.dir ? TEXT.titles.availableInstall(entry.name) : TEXT.titles.noDir,
                  onClick: () => installFound(entry),
                },
                rowBusy === 'install' ? TEXT.installing : TEXT.install,
              )
            : h('span', { className: 'hpx-no-ui', title: TEXT.titles.agentOnly }, TEXT.noInstall),
        )
        return h(
          'div',
          { key, className: 'hpx-row' },
          renderTile(entry.name),
          h(
            'div',
            { className: 'hpx-row-main' },
            h(
              'div',
              { className: 'hpx-row-title-line' },
              h('span', { className: 'hpx-row-title' }, entry.label),
              entry.version ? h('span', { className: 'hpx-badge' }, `v${entry.version}`) : null,
              entry.hasDesktop ? null : h('span', { className: 'hpx-badge' }, TEXT.badges.agentOnly),
              entry.hasBackend
                ? h('span', { className: 'hpx-badge', title: TEXT.titles.backendBadge }, TEXT.badges.backend)
                : null,
            ),
            entry.dir ? h('p', { className: 'hpx-row-path', title: entry.dir }, entry.dir) : null,
          ),
          tail,
        )
      }

      const sections = []
      if (tab === 'installed') {
        sections.push(
          h(
            'section',
            { key: 'installed', className: 'hpx-section' },
            h(
              'div',
              { className: 'hpx-section-head' },
              h('h2', { className: 'hpx-section-title' }, TEXT.sectionInstalled),
              plugins.length > 0 && !loading ? h('span', { className: 'hpx-section-note' }, String(desktopPlugins.length)) : null,
            ),
            loading && plugins.length === 0
              ? h('div', { className: 'hpx-quiet' }, TEXT.loading)
              : desktopPlugins.length === 0
                ? h(
                    'div',
                    { className: 'hpx-quiet' },
                    h('span', null, TEXT.emptyInstalled),
                    h('span', null, TEXT.emptyInstalledHint),
                  )
                : h('div', { className: 'hpx-rows' }, desktopPlugins.map(renderInstalledRow)),
          ),
        )
        if (agentPlugins.length > 0) {
          sections.push(
            h(
              'section',
              { key: 'agent-only', className: 'hpx-section' },
              h(
                'div',
                { className: 'hpx-section-head' },
                h('h2', { className: 'hpx-section-title' }, TEXT.sectionAgentOnly),
              ),
              h('div', { className: 'hpx-rows' }, agentPlugins.map(renderInstalledRow)),
            ),
          )
        }
      } else {
        sections.push(
          h(
            'section',
            { key: 'found', className: 'hpx-section' },
            h(
              'div',
              { className: 'hpx-section-head' },
              h('h2', { className: 'hpx-section-title' }, TEXT.sectionFound),
              list.available.length > 0 ? h('span', { className: 'hpx-section-note' }, String(list.available.length)) : null,
            ),
            h('p', { className: 'hpx-section-note' }, TEXT.foundHint),
            list.available.length === 0
              ? h('div', { className: 'hpx-quiet' }, TEXT.emptyFound)
              : h('div', { className: 'hpx-rows' }, list.available.map(renderFoundRow)),
          ),
        )
      }

      return h(
        'div',
        { className: 'hpx-page', 'data-hermes-plugins-page': '' },
        h(StyleTag),
        h(
          'div',
          { className: 'hpx-content' },
          h(
            'header',
            { className: 'hpx-head' },
            h(
              'div',
              { className: 'hpx-head-text' },
              h('h1', { className: 'hpx-title' }, TEXT.title),
              h('p', { className: 'hpx-subtitle' }, TEXT.subtitle),
            ),
            h(
              'div',
              { className: 'hpx-head-actions' },
              h(
                'button',
                {
                  className: 'hpx-icon-btn',
                  type: 'button',
                  title: TEXT.refresh,
                  'aria-label': TEXT.refresh,
                  onClick: () => store.refresh(),
                },
                h(Icon, { name: 'reload', size: 18 }),
              ),
              h(
                'div',
                { className: 'hpx-split' },
                h(
                  'button',
                  {
                    className: 'hpx-split-main',
                    type: 'button',
                    'aria-expanded': installOpen,
                    onClick: () => setInstallOpen((value) => !value),
                  },
                  h(Icon, { name: 'plus', size: 16 }),
                  TEXT.addPlugin,
                ),
                h(
                  'button',
                  {
                    ref: caretRef,
                    className: 'hpx-split-caret',
                    type: 'button',
                    'aria-haspopup': 'menu',
                    'aria-expanded': menuOpen,
                    'aria-label': TEXT.addMenuLabel,
                    title: TEXT.addMenuLabel,
                    onClick: () => setMenuOpen((value) => !value),
                  },
                  h(Icon, { name: 'chevron', size: 14 }),
                ),
                menuOpen
                  ? h(
                      'div',
                      { ref: menuRef, className: 'hpx-menu', role: 'menu', 'aria-label': TEXT.addMenuLabel },
                      h(
                        'button',
                        {
                          className: 'hpx-menu-item',
                          type: 'button',
                          role: 'menuitem',
                          onClick: () => openInstallForm('path'),
                        },
                        h(Icon, { name: 'folder', size: 14 }),
                        TEXT.addMenuLocal,
                      ),
                      h(
                        'button',
                        {
                          className: 'hpx-menu-item',
                          type: 'button',
                          role: 'menuitem',
                          onClick: () => openInstallForm('git'),
                        },
                        h(Icon, { name: 'git', size: 14 }),
                        TEXT.addMenuGit,
                      ),
                    )
                  : null,
              ),
            ),
          ),
          h(
            'div',
            { className: 'hpx-seg', role: 'tablist', 'aria-label': TEXT.tabsLabel },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: tab === 'installed' ? 'hpx-seg-btn is-on' : 'hpx-seg-btn',
                'aria-selected': tab === 'installed',
                onClick: () => setTab('installed'),
              },
              TEXT.tabInstalled,
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                className: tab === 'found' ? 'hpx-seg-btn is-on' : 'hpx-seg-btn',
                'aria-selected': tab === 'found',
                onClick: () => setTab('found'),
              },
              TEXT.tabFound,
            ),
          ),
          installOpen
            ? h(
                'form',
                { className: 'hpx-install-bar', onSubmit: submitInstall },
                h('input', {
                  ref: inputRef,
                  className: 'hpx-input',
                  type: 'text',
                  value: installSource,
                  placeholder: installMode === 'git' ? TEXT.installPlaceholderGit : TEXT.installPlaceholderPath,
                  disabled: installing,
                  spellCheck: false,
                  autoComplete: 'off',
                  'aria-label': installMode === 'git' ? TEXT.addMenuGit : TEXT.addMenuLocal,
                  onChange: (event) => setInstallSource(event.target.value),
                }),
                h(
                  'button',
                  {
                    className: 'hpx-open-btn',
                    type: 'submit',
                    disabled: installing || !String(installSource || '').trim(),
                  },
                  installing ? TEXT.installing : TEXT.install,
                ),
              )
            : null,
          installError
            ? h(
                'div',
                { className: 'hpx-inline-error', role: 'alert' },
                h(Icon, { name: 'alert', size: 14 }),
                h('span', null, installError),
                h('button', { className: 'hpx-text-btn', type: 'button', onClick: () => setInstallError(null) }, TEXT.dismiss),
              )
            : null,
          actionError
            ? h(
                'div',
                { className: 'hpx-inline-error', role: 'alert' },
                h(Icon, { name: 'alert', size: 14 }),
                h('span', null, actionError),
                h('button', { className: 'hpx-text-btn', type: 'button', onClick: () => setActionError(null) }, TEXT.dismiss),
              )
            : null,
          list.error && list.error !== installError
            ? h(
                'div',
                { className: 'hpx-inline-error', role: 'alert' },
                h(Icon, { name: 'alert', size: 14 }),
                h('span', null, TEXT.listFailed + ' ' + list.error),
                h('button', { className: 'hpx-text-btn', type: 'button', onClick: () => store.refresh() }, TEXT.retry),
              )
            : null,
          assetsReady
            ? null
            : h(
                'div',
                { className: 'hpx-inline-warn', role: 'status' },
                h(Icon, { name: 'alert', size: 14 }),
                h('span', null, TEXT.runtimeMissing),
              ),
          sections,
          h(
            'div',
            { className: 'hpx-foot' },
            list.store ? h('span', null, h('span', null, TEXT.storeLabel + ': '), h('span', { className: 'hpx-mono' }, list.store)) : null,
            routeMode ? h('span', null, `${TEXT.modeLabel}: ${routeMode === 'primary' ? '/api/hermes-plugins' : '/hermes-plugins'}`) : null,
            list.hermesPluginsDir
              ? h('span', { className: 'hpx-mono', title: list.hermesPluginsDir }, list.hermesPluginsDir)
              : null,
            list.hermesHome ? h('span', { className: 'hpx-mono', title: list.hermesHome }, list.hermesHome) : null,
          ),
        ),
      )
    }
    /* ------------------------------------------------------------------ */
    /* Plugin                                                             */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'layout', 'uiWorkspace'],
      apply(ctx) {
        const layout = ctx.layout || (typeof ctx.get === 'function' ? ctx.get('layout') : undefined)
        const uiWorkspace = ctx.uiWorkspace || (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined)
        const openPanel = (panelId) => {
          try {
            if (layout && typeof layout.selectPanel === 'function') {
              layout.selectPanel(panelId)
              return
            }
          } catch (error) {
            /* fall through to the hash hint */
          }
          try {
            window.location.hash = `#${panelId}`
          } catch (error) {
            /* ignore */
          }
        }

        const hostBridge = makeHostBridge(uiWorkspace)

        /* Prime the store; the inject callbacks below register from its snapshot
           and re-register on every change, so panels appear without a reload. */
        pluginStore.refresh()

        /* One effect owns every `main` registration: the management page plus one
           lazy panel per installed plugin that has a desktop half. */
        ctx.slots.inject('main', () => {
          const registered = new Map()
          const register = (item) =>
            ctx.slots.register(
              { name: 'main', key: item.id },
              (slotProps) => h(PluginPanelHost, Object.assign({}, slotProps, { pluginName: item.name, hostBridge })),
            )
          const management = ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            (slotProps) => h(HermesPluginsPage, Object.assign({}, slotProps, { store: pluginStore, openPanel })),
          )
          const sync = () => syncMainPanels(registered, desiredPanels(pluginStore.getSnapshot()), register)
          sync()
          const unsubscribe = pluginStore.subscribe(sync)
          return () => {
            unsubscribe()
            for (const entry of Array.from(registered.values())) {
              try {
                entry.disposer()
              } catch (error) {
                /* ignore */
              }
            }
            registered.clear()
            try {
              management()
            } catch (error) {
              /* ignore */
            }
          }
        })

        /* Same for the sidebar: management entry (order 30) plus one coloured
           icon per installed desktop plugin (orders 40, 41, ...). */
        ctx.slots.inject('sidebar.panellist', () => {
          const registered = new Map()
          const register = (item) =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: item.id, order: item.order, label: item.label },
              (slotProps) => h(PluginIcon, Object.assign({}, slotProps, { name: item.name, open: () => openPanel(item.id) })),
            )
          const management = ctx.slots.register(
            { name: 'sidebar.panellist', id: ENTRY_ID, order: 30, label: TEXT.title },
            (slotProps) => h(PanelIcon, Object.assign({}, slotProps, { open: () => openPanel(PANEL_ID) })),
          )
          const sync = () => syncSidebarPanels(registered, desiredPanels(pluginStore.getSnapshot()), register)
          sync()
          const unsubscribe = pluginStore.subscribe(sync)
          return () => {
            unsubscribe()
            for (const entry of Array.from(registered.values())) {
              try {
                entry.disposer()
              } catch (error) {
                /* ignore */
              }
            }
            registered.clear()
            try {
              management()
            } catch (error) {
              /* ignore */
            }
          }
        })

        /* The SDK stylesheet is app-wide; panels dispose their own instances. */
        try {
          ctx.effect(() => () => {
            removeSdkStyle()
          })
        } catch (error) {
          /* ctx.effect absent in older harness builds: nothing to own here. */
        }
      },
    }
  },
})
