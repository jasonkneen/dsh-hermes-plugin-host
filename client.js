/**
 * Browser half of the Hermes Plugin Host bundle.
 *
 * Two contributions, both over the same set of Host routes:
 *  - `main` (key `hermes-plugins`): the Hermes Plugins management page — the list
 *    of installed hermes plugin directories, an install field (absolute path or
 *    git/https URL), per-plugin Run/Stop/Reload/Uninstall controls, and the
 *    running plugin's own desktop half rendered full-width below.
 *  - `sidebar.panellist` (id `hermes-plugins`): the sidebar entry that opens it.
 *
 * Running a plugin is the interesting part: `web/runtime.js` and `web/sdk.js`
 * are plain ESM fetched from the Host as text, imported through blob URLs, and
 * handed to `createHermesRuntime({ React, createSdk, api })`; the page's `api.rest`
 * owns the two-carrier backend transport (see `rest()` below). The Root is a
 * normal React component, so it renders inside this page with the Harness theme
 * (no iframe). Every instance is disposed on switch, Stop, Reload and unmount.
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
    const LIST_POLL_MS = 12000

    const TEXT = {
      title: 'Hermes Plugins',
      explainer: 'Install Hermes Desktop plugins and run their desktop half inside this page.',
      installed: (count) => `${count} installed`,
      refresh: 'Refresh',
      installPlaceholder: '/absolute/path/to/hermes-plugin or https://github.com/owner/repo',
      install: 'Install',
      installing: 'Installing…',
      installHint: 'Paste a local plugin directory or a git/https URL. The directory needs plugin.yaml or desktop/plugin.js.',
      run: 'Run',
      starting: 'Starting…',
      stop: 'Stop',
      reload: 'Reload',
      uninstall: 'Uninstall',
      removeBusy: 'Removing…',
      confirmRemove: 'Confirm remove',
      cancel: 'Cancel',
      loading: 'Loading installed plugins…',
      empty: 'No hermes plugins installed yet. Paste a plugin path or git URL above and press Install.',
      noDescription: 'No description in plugin.yaml.',
      noDesktop: 'This plugin has no desktop half, so it cannot be run here.',
      runningTitle: (label) => `Running ${label}`,
      runHint: 'Nothing is running. Pick a plugin above and press Run.',
      runLoading: 'Starting the plugin…',
      runFrameLabel: 'Plugin UI',
      crash: 'The plugin UI crashed',
      crashHint: 'Its render threw. Reload or stop the plugin — the page stays usable.',
      storeLabel: 'Store',
      modeLabel: 'Route',
      availableTitle: 'Found in ~/.hermes/plugins (not installed)',
      availableHint: 'Read-only scan of your Hermes home. Installing copies the plugin into the Host store.',
      installFrom: 'Install',
      runtimeMissing: 'Plugin runtime assets are missing on the Host (web/runtime.js, web/sdk.js, web/sdk.css). Run is disabled until they exist — restart the Host after adding them.',
      backendUnreachable: 'The plugin backend is unreachable.',
      backendFailed: (status) => `Backend request failed (HTTP ${status})`,
      backendNotMounted: (status) => `The plugin backend route is not mounted (HTTP ${status}).`,
      badges: {
        desktop: 'desktop',
        backend: 'backend',
        tools: (names) => `tools: ${names.join(', ')}`,
        broken: 'manifest',
        hermesHome: 'hermes home',
        warning: 'warning',
        agentOnly: 'agent-only',
      },
      listFailed: 'Could not load the plugin list.',
      retry: 'Retry',
      dismiss: 'Dismiss',
      installFailed: 'Install failed.',
      removeFailed: 'Uninstall failed.',
      loadList: 'Hermes Plugin Host is unreachable.',
      unknownError: 'unknown error',
      timeout: 'the request timed out',
      requestFailed: (status) => `request failed (HTTP ${status})`,
      httpStatus: (status) => `HTTP ${status}`,
      unexpectedHtml: (status) => `unexpected HTML response (HTTP ${status})`,
      htmlResponse: 'unexpected HTML response',
      notJson: 'the response was not JSON',
      unexpectedPayload: 'unexpected response payload',
      emptyResponse: 'empty response',
      errors: {
        runtimeLoad: (reason) => `Could not load the Hermes runtime: ${reason}`,
        sdkLoad: (reason) => `Could not load the Hermes SDK shim: ${reason}`,
        cssLoad: (reason) => `Could not load the Hermes stylesheet: ${reason}`,
        noRuntimeExport: 'The Hermes runtime module has no createHermesRuntime export.',
        noSdkExport: 'The Hermes SDK shim has no createSdk export.',
        noLoadMethod: 'The Hermes runtime has no load() method.',
        noRoot: 'The plugin registered no Root component.',
        sourceRead: 'Could not read the plugin source.',
        sourceMissing: 'The plugin has no desktop/plugin.js source to run.',
      },
      titles: {
        desktopBadge: 'Has desktop/plugin.js',
        backendBadge: 'Has a Python backend half',
        stop: 'Stop this plugin and dispose its runtime',
        run: 'Load desktop/plugin.js and render its UI below',
        reload: 'Reload the plugin source and runtime',
        reloadDisabled: 'Run the plugin first',
        remove: 'Remove this plugin from the store',
        confirmRemove: 'Press again to remove this plugin from the store',
        availableInstall: (name) => `Install ${name} from ~/.hermes/plugins`,
        noDir: 'No directory reported',
        agentOnly: 'Agent-only plugin: it has no desktop or backend half to install or run here.',
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
     * Fetch runtime + sdk + sdk.css and turn them into live module functions.
     * Refetched on every run so editing `web/*.js` and pressing Reload picks up
     * the change without restarting the Harness.
     */
    async function loadRuntimeModules() {
      const [runtimeText, sdkText, css] = await Promise.all([
        fetchText('module', 'name=runtime', 30000),
        fetchText('module', 'name=sdk', 30000),
        fetchText('module', 'name=sdk.css', 30000),
      ])
      if (!runtimeText.ok) throw new Error(TEXT.errors.runtimeLoad(runtimeText.error))
      if (!sdkText.ok) throw new Error(TEXT.errors.sdkLoad(sdkText.error))
      if (!css.ok) throw new Error(TEXT.errors.cssLoad(css.error))
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

    async function loadPluginSource(name) {
      const payload = await fetchJson('source', { query: `name=${encodeURIComponent(name)}` })
      if (!payload.ok) throw new Error(payload.error || TEXT.errors.sourceRead)
      if (typeof payload.source !== 'string' || !payload.source) {
        throw new Error(TEXT.errors.sourceMissing)
      }
      return payload.source
    }

    /** The instance currently mounted (or loading) on the page. */
    let activeInstance = null

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
.hpx-page{position:relative;display:flex;flex-direction:column;height:100%;min-height:440px;min-width:0;overflow:hidden;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.45}
.hpx-page *{box-sizing:border-box}
.hpx-toolbar{flex:none;display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 14px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.hpx-brand{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;letter-spacing:.01em;min-width:0}
.hpx-brand-icon{display:flex;color:var(--dsw-alias-brand-primary)}
.hpx-pill{flex:none;display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.hpx-grow{flex:1 1 auto;min-width:0}
.hpx-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
.hpx-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.hpx-btn:active{transform:translateY(.5px)}
.hpx-btn[disabled]{opacity:.45;cursor:default;transform:none}
.hpx-btn-accent{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.hpx-btn-accent:hover{background:var(--dsw-alias-bg-layer-1)}
.hpx-btn-danger{color:var(--dsw-alias-state-error-primary)}
.hpx-btn-danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)}
.hpx-btn-icon{width:28px;padding:0}
.hpx-btn-tiny{height:24px;font-size:11.5px;padding:0 9px}
.hpx-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
.hpx-explainer{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hpx-install{display:flex;align-items:center;gap:8px}
.hpx-input{flex:1 1 auto;min-width:0;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px}
.hpx-input::placeholder{color:var(--dsw-alias-label-secondary)}
.hpx-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.hpx-input[disabled]{opacity:.6}
.hpx-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.hpx-error{display:flex;align-items:flex-start;gap:7px;padding:8px 10px;border-radius:8px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-border-l1));
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent);
  color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.45;word-break:break-word}
.hpx-error-body{display:flex;flex-direction:column;gap:3px;min-width:0}
.hpx-warn{display:flex;align-items:flex-start;gap:7px;padding:6px 9px;border-radius:8px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, var(--dsw-alias-border-l1));
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent);
  color:var(--dsw-alias-state-warn-primary);font-size:11.5px;line-height:1.45;word-break:break-word}
.hpx-list{display:flex;flex-direction:column;gap:8px}
.hpx-section-title{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);margin:2px 0 0}
.hpx-card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.hpx-card.is-flash{border-color:var(--dsw-alias-brand-primary)}
.hpx-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.hpx-row-title{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hpx-version{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.hpx-badges{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-left:auto}
.hpx-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l1);font-size:10px;letter-spacing:.02em;
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
.hpx-badge.is-desktop{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 40%, var(--dsw-alias-border-l1))}
.hpx-badge.is-backend{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, var(--dsw-alias-border-l1))}
.hpx-badge.is-broken{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1))}
.hpx-badge.is-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l1));
  max-width:220px;overflow:hidden;text-overflow:ellipsis}
.hpx-desc{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.45;white-space:pre-wrap}
.hpx-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hpx-actions{display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap}
.hpx-running-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.hpx-empty{padding:16px;border-radius:10px;border:1px dashed var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary);font-size:12px;text-align:center;line-height:1.5}
.hpx-run{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.hpx-run-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hpx-run-title{font-size:12.5px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hpx-run-frame{display:flex;flex-direction:column;min-height:380px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.hpx-run-frame .hph-root{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.hpx-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-secondary);padding-top:2px}
.hpx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
@media (prefers-reduced-motion:reduce){.hpx-btn{transition:none}}
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
    /* Sidebar icon                                                       */
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

    /* ------------------------------------------------------------------ */
    /* Page                                                               */
    /* ------------------------------------------------------------------ */

    function HermesPluginsPage() {
      const [list, setList] = useState({
        status: 'loading',
        plugins: [],
        available: [],
        store: null,
        hermesHome: null,
        hermesPluginsDir: null,
        webAssets: true,
        error: null,
      })
      const [installSource, setInstallSource] = useState('')
      const [installing, setInstalling] = useState(false)
      const [installError, setInstallError] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [busy, setBusy] = useState({})
      const [confirmRemove, setConfirmRemove] = useState(null)
      const [running, setRunning] = useState(null)
      const [runPhase, setRunPhase] = useState('idle')
      const [runError, setRunError] = useState(null)
      const [flash, setFlash] = useState(null)

      const mountedRef = useRef(true)
      /** Bumped on Stop/unmount/another Run so a stale async run disposes itself. */
      const seqRef = useRef(0)
      const runningRef = useRef(null)

      const applyRunning = useCallback((entry) => {
        runningRef.current = entry
        activeInstance = entry ? entry.instance : null
        setRunning(entry)
      }, [])

      const loadList = useCallback(async () => {
        const payload = await fetchJson('list')
        if (!mountedRef.current) return
        if (!payload.ok) {
          setList((previous) => Object.assign({}, previous, { status: previous.plugins.length ? 'stale' : 'error', error: payload.error }))
          return
        }
        const plugins = Array.isArray(payload.plugins) ? payload.plugins.map(normalizePlugin).filter(Boolean) : []
        setList({
          status: 'online',
          plugins,
          available: normalizeAvailable(payload),
          store: typeof payload.store === 'string' ? payload.store : null,
          hermesHome: typeof payload.hermesHome === 'string' ? payload.hermesHome : null,
          hermesPluginsDir: typeof payload.hermesPluginsDir === 'string' ? payload.hermesPluginsDir : null,
          webAssets: payload.webAssets !== false,
          error: null,
        })
      }, [])

      /* Mount, poll, and dispose the plugin UI on unmount. */
      useEffect(() => {
        mountedRef.current = true
        loadList()
        const timer = setInterval(() => {
          try {
            if (typeof document !== 'undefined' && document.hidden) return
          } catch (error) {
            /* ignore */
          }
          loadList()
        }, LIST_POLL_MS)
        return () => {
          mountedRef.current = false
          seqRef.current += 1
          clearInterval(timer)
          disposeInstance(runningRef.current ? runningRef.current.instance : null)
          runningRef.current = null
          activeInstance = null
        }
      }, [loadList])

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

      const stopRun = useCallback(
        (name) => {
          const current = runningRef.current
          if (!current) return
          if (name && current.name !== name) return
          seqRef.current += 1
          disposeInstance(current.instance)
          applyRunning(null)
          setRunPhase('idle')
          setRunError(null)
        },
        [applyRunning],
      )

      const startRun = useCallback(
        async (plugin, label) => {
          const gen = seqRef.current + 1
          seqRef.current = gen
          const current = runningRef.current
          if (current) {
            disposeInstance(current.instance)
            applyRunning(null)
          }
          setRunPhase('loading')
          setRunError(null)
          markBusy(setBusy, plugin.name, label)
          try {
            const [sourceText, modules] = await Promise.all([loadPluginSource(plugin.name), loadRuntimeModules()])
            if (!mountedRef.current || gen !== seqRef.current) return
            // The page owns carrier selection, so hand the runtime its REST transport.
            const apiBase = routeMode === 'fallback' ? '/hermes-plugins' : '/api/hermes-plugins'
            const runtime = modules.createHermesRuntime({
              React,
              createSdk: modules.createSdk,
              api: { rest },
              apiBase,
            })
            if (!runtime || typeof runtime.load !== 'function') {
              throw new Error(TEXT.errors.noLoadMethod)
            }
            const instance = await runtime.load(plugin, sourceText)
            if (!mountedRef.current || gen !== seqRef.current) {
              disposeInstance(instance)
              return
            }
            if (!instance || !instance.Root) throw new Error(TEXT.errors.noRoot)
            applyRunning({ name: plugin.name, label: plugin.label || plugin.name, instance, startedAt: Date.now(), info: plugin })
            setRunPhase('ready')
          } catch (error) {
            if (mountedRef.current && gen === seqRef.current) {
              setRunPhase('error')
              setRunError(String((error && error.message) || error))
            }
          } finally {
            if (mountedRef.current) clearBusy(setBusy, plugin.name)
          }
        },
        [applyRunning],
      )

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
            if (payload.plugin && payload.plugin.name) setFlash(String(payload.plugin.name))
            await loadList()
          } catch (error) {
            if (mountedRef.current) setInstallError(String((error && error.message) || error))
          } finally {
            if (mountedRef.current) setInstalling(false)
          }
        },
        [installSource, installing, loadList],
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
            stopRun(plugin.name)
            await loadList()
          } catch (error) {
            if (mountedRef.current) setActionError(String((error && error.message) || error))
          } finally {
            if (mountedRef.current) clearBusy(setBusy, plugin.name)
          }
        },
        [loadList, stopRun],
      )

      const plugins = list.plugins
      /** list.webAssets === false means web/runtime.js|sdk.js|sdk.css are missing. */
      const assetsReady = list.webAssets !== false
      const runningEntry = running
      const runningInList = runningEntry ? plugins.some((plugin) => plugin.name === runningEntry.name) : false
      const runKey = runningEntry ? `${runningEntry.name}:${runningEntry.startedAt}` : 'none'

      return h(
        'div',
        { className: 'hpx-page', 'data-hermes-plugins-page': '' },
        h(StyleTag),
        h(
          'div',
          { className: 'hpx-toolbar' },
          h('span', { className: 'hpx-brand-icon' }, h(Icon, { name: 'plugins', size: 17 })),
          h('span', { className: 'hpx-brand' }, TEXT.title),
          h('span', { className: 'hpx-pill' }, TEXT.installed(plugins.length)),
          h('div', { className: 'hpx-grow' }),
          h(
            'button',
            {
              className: 'hpx-btn hpx-btn-icon',
              title: TEXT.refresh,
              'aria-label': TEXT.refresh,
              onClick: () => loadList(),
            },
            h(Icon, { name: 'reload', size: 14 }),
          ),
        ),
        h(
          'div',
          { className: 'hpx-body' },
          h('p', { className: 'hpx-explainer' }, TEXT.explainer),
          h(
            'form',
            { className: 'hpx-install', onSubmit: submitInstall },
            h('input', {
              className: 'hpx-input',
              type: 'text',
              value: installSource,
              placeholder: TEXT.installPlaceholder,
              disabled: installing,
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': TEXT.installPlaceholder,
              onChange: (event) => setInstallSource(event.target.value),
            }),
            h(
              'button',
              {
                className: 'hpx-btn hpx-btn-accent',
                type: 'submit',
                disabled: installing || !String(installSource || '').trim(),
              },
              h(Icon, { name: 'plus', size: 13 }),
              installing ? TEXT.installing : TEXT.install,
            ),
          ),
          h('div', { className: 'hpx-note' }, TEXT.installHint),
          assetsReady
            ? null
            : h(
                'div',
                { className: 'hpx-warn', role: 'status' },
                h(Icon, { name: 'alert', size: 13 }),
                h('span', null, TEXT.runtimeMissing),
              ),
          installError
            ? h(
                'div',
                { className: 'hpx-error', role: 'alert' },
                h(Icon, { name: 'alert', size: 14 }),
                h('div', { className: 'hpx-error-body' }, h('strong', null, TEXT.installFailed), h('span', null, installError)),
              )
            : null,
          actionError
            ? h(
                'div',
                { className: 'hpx-error', role: 'alert' },
                h(Icon, { name: 'alert', size: 14 }),
                h('div', { className: 'hpx-error-body' }, h('span', null, actionError)),
                h('button', { className: 'hpx-btn hpx-btn-tiny', onClick: () => setActionError(null) }, TEXT.dismiss),
              )
            : null,

          /* List transport / host errors — never blank the page. */
          list.error && list.error !== installError
            ? h(
                'div',
                { className: 'hpx-error', role: 'alert' },
                h(Icon, { name: 'alert', size: 14 }),
                h(
                  'div',
                  { className: 'hpx-error-body' },
                  h('strong', null, TEXT.listFailed),
                  h('span', null, list.error),
                ),
                h(
                  'button',
                  { className: 'hpx-btn hpx-btn-tiny', onClick: () => loadList() },
                  TEXT.retry,
                ),
              )
            : null,

          plugins.length === 0 && list.status === 'loading'
            ? h('div', { className: 'hpx-empty' }, TEXT.loading)
            : plugins.length === 0
              ? h('div', { className: 'hpx-empty' }, TEXT.empty)
              : h(
                  'div',
                  { className: 'hpx-list' },
                  plugins.map((plugin) => {
                    const isRunning = !!runningEntry && runningEntry.name === plugin.name
                    const rowBusy = busy[plugin.name] || null
                    const confirm = confirmRemove === plugin.name
                    return h(
                      'article',
                      {
                        key: plugin.name,
                        className: flash === plugin.name ? 'hpx-card is-flash' : 'hpx-card',
                      },
                      h(
                        'div',
                        { className: 'hpx-row-head' },
                        isRunning
                          ? h('span', { className: 'hpx-running-dot', title: TEXT.runningTitle(plugin.label) })
                          : null,
                        h('span', { className: 'hpx-row-title', title: plugin.dir || plugin.name }, plugin.label),
                        plugin.version ? h('span', { className: 'hpx-version' }, `v${plugin.version}`) : null,
                        h(
                          'div',
                          { className: 'hpx-badges' },
                          plugin.hasDesktop
                            ? h('span', { className: 'hpx-badge is-desktop', title: TEXT.titles.desktopBadge }, TEXT.badges.desktop)
                            : null,
                          plugin.hasBackend
                            ? h(
                                'span',
                                { className: 'hpx-badge is-backend', title: plugin.backendApi ? `dashboard/${plugin.backendApi}` : TEXT.titles.backendBadge },
                                TEXT.badges.backend,
                              )
                            : null,
                          plugin.providesTools.length
                            ? h('span', { className: 'hpx-badge' }, TEXT.badges.tools(plugin.providesTools))
                            : null,
                          plugin.warnings.map((warning) =>
                            h('span', { key: `warning:${warning}`, className: 'hpx-badge is-warn', title: warning }, warning),
                          ),
                          plugin.error ? h('span', { className: 'hpx-badge is-broken' }, TEXT.badges.broken) : null,
                        ),
                      ),
                      h('p', { className: 'hpx-desc' }, plugin.description || TEXT.noDescription),
                      plugin.dir ? h('div', { className: 'hpx-path', title: plugin.dir }, plugin.dir) : null,
                      plugin.error
                        ? h(
                            'div',
                            { className: 'hpx-warn', role: 'status' },
                            h(Icon, { name: 'alert', size: 13 }),
                            h('span', null, plugin.error),
                          )
                        : null,
                      h(
                        'div',
                        { className: 'hpx-actions' },
                        isRunning
                          ? h(
                              'button',
                              {
                                className: 'hpx-btn hpx-btn-tiny',
                                disabled: !!rowBusy,
                                onClick: () => stopRun(plugin.name),
                                title: TEXT.titles.stop,
                              },
                              h(Icon, { name: 'stop', size: 12 }),
                              TEXT.stop,
                            )
                          : h(
                              'button',
                              {
                                className: 'hpx-btn hpx-btn-tiny hpx-btn-accent',
                                disabled: !!rowBusy || !plugin.hasDesktop || !assetsReady,
                                title: !assetsReady ? TEXT.runtimeMissing : plugin.hasDesktop ? TEXT.titles.run : TEXT.noDesktop,
                                onClick: () => startRun(plugin, 'run'),
                              },
                              h(Icon, { name: 'play', size: 12 }),
                              rowBusy === 'run' ? TEXT.starting : TEXT.run,
                            ),
                        h(
                          'button',
                          {
                            className: 'hpx-btn hpx-btn-tiny',
                            disabled: !!rowBusy || !isRunning,
                            title: isRunning ? TEXT.titles.reload : TEXT.titles.reloadDisabled,
                            onClick: () => startRun(plugin, 'reload'),
                          },
                          h(Icon, { name: 'reload', size: 12 }),
                          rowBusy === 'reload' ? TEXT.starting : TEXT.reload,
                        ),
                        h(
                          'button',
                          {
                            className: confirm ? 'hpx-btn hpx-btn-tiny hpx-btn-danger' : 'hpx-btn hpx-btn-tiny',
                            disabled: !!rowBusy,
                            title: confirm ? TEXT.titles.confirmRemove : TEXT.titles.remove,
                            onClick: () => {
                              if (confirm) removePlugin(plugin)
                              else setConfirmRemove(plugin.name)
                            },
                          },
                          h(Icon, { name: 'trash', size: 12 }),
                          rowBusy === 'remove' ? TEXT.removeBusy : confirm ? TEXT.confirmRemove : TEXT.uninstall,
                        ),
                        confirm
                          ? h(
                              'button',
                              {
                                className: 'hpx-btn hpx-btn-tiny',
                                disabled: !!rowBusy,
                                onClick: () => setConfirmRemove(null),
                              },
                              TEXT.cancel,
                            )
                          : null,
                      ),
                    )
                  }),
                ),

          list.available.length
            ? h(
                'div',
                { className: 'hpx-list' },
                h('div', { className: 'hpx-section-title' }, TEXT.availableTitle),
                h('div', { className: 'hpx-note' }, TEXT.availableHint),
                list.available.map((entry) =>
                  h(
                    'div',
                    { key: `available:${entry.name}`, className: 'hpx-card' },
                    h(
                      'div',
                      { className: 'hpx-row-head' },
                      h('span', { className: 'hpx-row-title' }, entry.label),
                      entry.version ? h('span', { className: 'hpx-version' }, `v${entry.version}`) : null,
                      h(
                        'div',
                        { className: 'hpx-badges' },
                        entry.hasDesktop
                          ? h('span', { className: 'hpx-badge is-desktop', title: TEXT.titles.desktopBadge }, TEXT.badges.desktop)
                          : null,
                        entry.hasBackend
                          ? h('span', { className: 'hpx-badge is-backend', title: TEXT.titles.backendBadge }, TEXT.badges.backend)
                          : null,
                        entry.installable ? null : h('span', { className: 'hpx-badge' }, TEXT.badges.agentOnly),
                        h('span', { className: 'hpx-badge' }, TEXT.badges.hermesHome),
                      ),
                    ),
                    entry.dir ? h('div', { className: 'hpx-path', title: entry.dir }, entry.dir) : null,
                    h(
                      'div',
                      { className: 'hpx-actions' },
                      entry.installable
                        ? h(
                            'button',
                            {
                              className: 'hpx-btn hpx-btn-tiny hpx-btn-accent',
                              disabled: !entry.dir || !!busy[`available:${entry.name}`],
                              title: entry.dir ? TEXT.titles.availableInstall(entry.name) : TEXT.titles.noDir,
                              onClick: () => {
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
                                    return loadList()
                                  })
                                  .catch((error) => {
                                    if (mountedRef.current) setInstallError(String((error && error.message) || error))
                                  })
                                  .finally(() => {
                                    if (mountedRef.current) clearBusy(setBusy, key)
                                  })
                              },
                            },
                            h(Icon, { name: 'plus', size: 12 }),
                            TEXT.installFrom,
                          )
                        : h(
                            'button',
                            {
                              className: 'hpx-btn hpx-btn-tiny',
                              disabled: true,
                              title: TEXT.titles.agentOnly,
                            },
                            TEXT.installFrom,
                          ),
                    ),
                  ),
                ),
              )
            : null,

          /* Running plugin: its own UI, full width, below the list. */
          h(
            'div',
            { className: 'hpx-run' },
            h(
              'div',
              { className: 'hpx-run-head' },
              h(Icon, { name: 'plugins', size: 14 }),
              h(
                'span',
                { className: 'hpx-run-title' },
                runningEntry ? TEXT.runningTitle(runningEntry.label) : TEXT.runFrameLabel,
              ),
              runningEntry ? h('span', { className: 'hpx-pill' }, runningEntry.name) : null,
              h('div', { className: 'hpx-grow' }),
              runningEntry
                ? h(
                    'button',
                    {
                      className: 'hpx-btn hpx-btn-tiny',
                      disabled: !!busy[runningEntry.name],
                      title: TEXT.titles.reload,
                      onClick: () => {
                        const info = runningEntry.info || plugins.find((plugin) => plugin.name === runningEntry.name)
                        if (info) startRun(info, 'reload')
                      },
                    },
                    h(Icon, { name: 'reload', size: 12 }),
                    TEXT.reload,
                  )
                : null,
              runningEntry
                ? h(
                    'button',
                    { className: 'hpx-btn hpx-btn-tiny', onClick: () => stopRun(runningEntry.name) },
                    h(Icon, { name: 'stop', size: 12 }),
                    TEXT.stop,
                  )
                : null,
            ),
            runPhase === 'loading' ? h('div', { className: 'hpx-empty' }, TEXT.runLoading) : null,
            runError
              ? h(
                  'div',
                  { className: 'hpx-error', role: 'alert' },
                  h(Icon, { name: 'alert', size: 14 }),
                  h('div', { className: 'hpx-error-body' }, h('strong', null, TEXT.crash), h('span', null, runError)),
                )
              : null,
            runningEntry
              ? h(
                  'div',
                  { className: 'hpx-run-frame' },
                  h(
                    PluginErrorBoundary,
                    { key: runKey },
                    h('div', { className: 'hph-root' }, h(runningEntry.instance.Root)),
                  ),
                )
              : !runningInList && runPhase === 'idle'
                ? h('div', { className: 'hpx-empty' }, TEXT.runHint)
                : null,
          ),

          h(
            'div',
            { className: 'hpx-foot' },
            list.store ? h('span', null, `${TEXT.storeLabel}: `, h('span', { className: 'hpx-mono' }, list.store)) : null,
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
      inject: ['slots', 'layout'],
      apply(ctx) {
        const layout = ctx.layout || (typeof ctx.get === 'function' ? ctx.get('layout') : undefined)
        const openPage = () => {
          try {
            if (layout && typeof layout.selectPanel === 'function') {
              layout.selectPanel(PANEL_ID)
              return
            }
          } catch (error) {
            /* fall through to the hash hint */
          }
          try {
            window.location.hash = `#${PANEL_ID}`
          } catch (error) {
            /* ignore */
          }
        }

        /* The page itself: `main` is keyed by the sidebar entry id. */
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, HermesPluginsPage))

        /* Sidebar entry; the shell selects `main` with this id when clicked. */
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: ENTRY_ID, order: 30, label: TEXT.title },
            (props) => h(PanelIcon, Object.assign({}, props, { open: openPage })),
          ),
        )

        /* Own the SDK stylesheet and any live instance for this plugin's lifetime. */
        try {
          ctx.effect(() => () => {
            disposeInstance(activeInstance)
            activeInstance = null
            removeSdkStyle()
          })
        } catch (error) {
          /* ctx.effect absent in older harness builds: still dispose on unload best-effort. */
        }
      },
    }
  },
})
