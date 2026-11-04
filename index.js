/**
 * Host half of the Hermes Plugin Host bundle.
 *
 * Installs, lists and runs Hermes Desktop plugins (`hermes-desktop-plugin-*`)
 * inside DeepSeek Harness. Three things live here:
 *
 * 1. **Registry** (`lib/registry.js`) — a store under `~/.dsh/hermes-plugins`
 *    holding copied plugin directories, plus reading `~/.hermes/plugins` for
 *    plugins Hermes Desktop itself installed.
 * 2. **Backend sidecars** (`lib/backend.js`, `lib/sidecar.py`) — each plugin's
 *    Python FastAPI half runs in one lazily-started process behind a private
 *    Unix socket, so its real data (office-3d's `/state`) is readable from the
 *    browser through one authenticated route.
 * 3. **HTTP routes + agent tools** (`lib/routes.js`, `lib/tools.js`) — the browser
 *    half fetches plugin source and raw backend responses from here, and the
 *    model drives installs and reads live plugin data through four tools.
 *
 * Every registration goes through `ctx.effect`, so unloading the plugin removes
 * its routes, its tools, and its Python processes.
 *
 * @module hermes-plugin-host
 */

import { createBackendManager } from './lib/backend.js'
import { resolveStoreDir } from './lib/registry.js'
import { createOperations, registerFallbackRoute, registerFetchRoutes } from './lib/routes.js'
import { createToolDefinitions, registerTools } from './lib/tools.js'

/** Loader entry name. */
export const name = 'hermes-plugin-host'
/** The tool registry is the only hard Host dependency; `webServer`/`connection` are optional. */
export const inject = ['tools']
/** Prompt-section order: right after the Design Canvas section (850). */
const PROMPT_ORDER = 855
/** Version reported by `api/health`; the package version is authoritative when readable. */
const FALLBACK_VERSION = '1.0.0'

const log = (...values) => {
  try {
    globalThis.console?.error?.('[hermes-plugin-host]', ...values)
  } catch {}
}

const asString = (value) => (typeof value === 'string' ? value : '')

/**
 * A reload replaces this module while the previous fiber may still hold its
 * registrations for a moment; a duplicate name, path or tool then rejects.
 * Retrying briefly turns that race into a working reload instead of a fault.
 *
 * @param register - idempotent registration returning a disposer.
 * @param label - what is being registered, for diagnostics.
 * @param onDispose - extra cleanup to run before the disposer.
 * @returns the effect disposer.
 */
function registerWithRetry(register, label, onDispose) {
  let cancelled = false
  let dispose
  let timer
  let tries = 0
  const attempt = () => {
    try {
      dispose = register()
    } catch (error) {
      if (cancelled) return
      if (tries < 6) {
        tries += 1
        timer = setTimeout(attempt, 250)
        timer.unref?.()
        return
      }
      log(`could not register ${label}`, error?.message ?? error)
    }
  }
  attempt()
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
    if (typeof onDispose === 'function') {
      try {
        onDispose()
      } catch {}
    }
    if (dispose) {
      try {
        Promise.resolve(dispose()).catch(() => {})
      } catch {}
    }
  }
}

/** Read this package's version without failing activation when it is unreadable. */
async function readPackageVersion() {
  try {
    const { readFile } = await import('node:fs/promises')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const packageDir = dirname(fileURLToPath(import.meta.url))
    const text = await readFile(join(packageDir, 'package.json'), 'utf8')
    const parsed = JSON.parse(text)
    return asString(parsed.version).trim() || FALLBACK_VERSION
  } catch {
    return FALLBACK_VERSION
  }
}

/**
 * Activate the Host half.
 *
 * @param ctx - Host context (tools registry, and optionally connection/webServer).
 * @param config - this row's config; `storeDir` overrides the registry location.
 */
export function apply(ctx, config) {
  const startedAt = Date.now()
  const store = resolveStoreDir(config ?? {})
  const backend = createBackendManager({ log })

  // The sidecar processes outlive individual requests: kill them on unload.
  ctx.effect(() => () => backend.dispose(), 'hermes-plugin-host: stop backend sidecars on unload')

  // Version is read asynchronously so activation stays synchronous; `health`
  // reports the package version once it lands.
  const versionState = { value: FALLBACK_VERSION }
  const ops = createOperations({ store, backend, log, version: () => versionState.value, startedAt })
  void readPackageVersion().then((version) => {
    versionState.value = version || FALLBACK_VERSION
  })

  // 1. Agent tools.
  const definitions = createToolDefinitions({ operations: ops, log })
  registerTools(ctx, definitions, registerWithRetry, log)

  // 2. One short prompt section so the model knows the capability exists.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    try {
      ctx.effect(
        () =>
          systemPrompt.section({
            name: 'hermes-plugins',
            order: PROMPT_ORDER,
            text: [
              '## Hermes Plugins',
              'This Harness can install and run Hermes Desktop plugins (the hermes-desktop-plugin-* family); `hermes_plugin_list` shows what is installed, `hermes_plugin_install` adds one from a local directory or git URL, and `hermes_plugin_remove` deletes one.',
              'An installed plugin has a browser UI half the user opens from the Hermes Plugins page, and some also have a Python backend half whose live data you can read with `hermes_plugin_backend` (for office-3d, GET /state returns each profile\'s online/busy state, sessions, tokens and cost) — the first call starts that backend and may take a few seconds.',
              'Prefer these tools over guessing at plugin state, and report the real numbers the backend returns.',
            ].join(' '),
          }),
        'hermes-plugin-host: prompt section',
      )
    } catch (error) {
      log('could not add the prompt section', error?.message ?? error)
    }
  }

  // 3. Routes. Primary: authenticated Fetch routes on Connection.
  const connection = ctx.get('connection')
  registerFetchRoutes(ctx, { connection, operations: ops, registerWithRetry, log })

  // Fallback: same-origin raw node route on the Web carrier.
  const webServer = ctx.get('webServer')
  registerFallbackRoute(ctx, { webServer, operations: ops, registerWithRetry, log })

  log(`ready; store ${store}`)
}
