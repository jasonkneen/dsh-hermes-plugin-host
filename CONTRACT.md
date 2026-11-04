# Hermes Plugin Host — interface contract (v1)

A DeepSeek Harness (DSH) plugin that **installs and runs Hermes Desktop plugins**
(the `hermes-desktop-plugin-*` family, e.g. `office-3d`) inside the DSH Web UI.

Package dir: `/Users/jkneen/Documents/GitHub/dsh-hermes-plugin-host`
Bundle id / package name: `dsh-hermes-plugin-host`
Runtime rows id: `hermes-plugin-host`

## What a Hermes plugin is

A directory (e.g. `~/Documents/GitHub/hermes-desktop-plugin-office-3d`) containing:

| Path | Meaning |
| --- | --- |
| `plugin.yaml` | manifest: `name`, `label`, `version`, `description`, `author`, `license`, `kind`, `platforms`, `provides_tools` |
| `desktop/plugin.js` | **desktop half**: one ESM file, `export default { id, name, defaultEnabled, register(ctx) }`; imports bare `@hermes/plugin-sdk`, `react`, `react/jsx-runtime` only |
| `dashboard/manifest.json` | `{ "name": "...", "api": "plugin_api.py" }` |
| `dashboard/plugin_api.py` | **backend half**: Python FastAPI module exposing `router = APIRouter()`; mounted by hermes at `/api/plugins/<name>/` |
| `__init__.py` | agent half (Python; registers hermes tools). **Out of scope for v1.** |

The `ctx` handed to `register(ctx)` in the desktop half provides:
`ctx.register({ id, area, data, order, render })`, `ctx.storage.get/set`,
`ctx.rest(path)`, `ctx.registerSettingsPage?.({ id, title, icon, order, render })`.

Areas (constants exported by `@hermes/plugin-sdk`): `ROUTES_AREA`,
`SIDEBAR_NAV_AREA`, `STATUSBAR_AREAS.right|left`, `PALETTE_AREA`, `KEYBINDS_AREA`.

`@hermes/plugin-sdk` also exports: `host`, `atom`, `useValue`, `useQuery`,
`profileColor`, `cn`, `EmptyState`, `ErrorState`, `Skeleton`, `ListRow`,
`ToggleRow`, `SegmentedControl`, `Tip`.

## File ownership (write scopes)

| Owner | Files |
| --- | --- |
| lead | `package.json`, `cordis.patch.yml`, `locale/en.json`, `icon.svg`, `README.md`, `CONTRACT.md` |
| host-dev | `index.js`, `cordis.patch.yml` (coordinate with lead — lead writes it), `lib/**` |
| client-dev | `client.js` |
| runtime-dev | `web/runtime.js`, `web/sdk.js`, `web/sdk.css` |

Do not edit files outside your scope. `lib/**` is host-only ESM. `client.js` and
`web/*` are browser-only ESM/classic.

## Studio layout

```
package.json          # name dsh-hermes-plugin-host, dsh.bundle.patch, dsh.client
cordis.patch.yml      # inserts row id: hermes-plugin-host, name: 'dsh-hermes-plugin-host'
index.js              # Host: export function apply(ctx, config)
lib/registry.js       # scan / install / remove hermes plugin dirs
lib/routes.js         # HTTP routes (contract A below)
lib/backend.js        # Python FastAPI sidecar manager (contract B below)
lib/tools.js          # agent tools (contract C below)
client.js             # Client: window.__ModuleLoader__.load({id, factory})
web/runtime.js        # browser ESM: hermes plugin.js loader + surface registry
web/sdk.js            # browser ESM: @hermes/plugin-sdk shim
web/sdk.css           # utility + component CSS for hermes plugin markup
locale/en.json        # meta.title / meta.description (+ ui strings)
icon.svg              # original icon
```

## A. Host HTTP routes (client-dev ↔ host-dev)

**Reference implementation to copy the transport from** (a working local plugin in
this exact profile — read it with the shell, it is not in app.asar):
`/Users/jkneen/Documents/GitHub/tinyglade-plus-two/plugins/design-canvas/index.js`
→ `export function apply(ctx)`, `registerExactRoute()`, `registerWithRetry()`,
`stateRoute`, `fallbackHandler`, `jsonResponse`, `badRequest`.

Two carriers, both registered, same handlers:

1. **Primary, authenticated**: `ctx.get('connection')` → `connection.fetch.register({ path, methods, requestBody: 'buffered', fetch: (request) => Response })`
   `fetch` receives a WHATWG `Request` and returns a WHATWG `Response`.
   Paths use the `/api/<name>/<op>` convention the client already fetches with
   `credentials: 'same-origin'`.
2. **Fallback, same-origin raw node**: `ctx.get('webServer').register({ kind: 'prefix', path: '/hermes-plugins', handler: (req, res) => ... })`
   used when Connection is absent; same operations under `/hermes-plugins/<op>`.
   Reject a cross-origin `Origin` header that does not match `Host` (403), as the
   reference does.

Both registrations must go through a retrying disposer inside `ctx.effect`
(the reference `registerWithRetry`), because the service may appear after us.

Operations (JSON in/out; `{ ok: true, ... }` or `{ ok: false, error: string }`):

| Op | Method | Request | Response |
| --- | --- | --- | --- |
| `list` | GET | — | `{ ok, store, hermesHome, plugins: PluginInfo[] }` |
| `install` | POST | `{ source, name?, overwrite? }` | `{ ok, plugin: PluginInfo }` |
| `remove` | POST | `{ name }` | `{ ok }` |
| `source` | GET | `?name=<n>` | `{ ok, name, source, bytes }` (`desktop/plugin.js` text) |
| `module` | GET | `?name=runtime\|sdk\|sdk.css` | raw text; `text/javascript` for runtime/sdk, `text/css` for sdk.css |
| `health` | GET | — | `{ ok, version, store }` |
| `backend/<plugin>/<rest...>` | ANY | proxied | sidecar response |

Client-side helper: try `/api/hermes-plugins/<op>` first; on network failure or
non-2xx **HTML** response, retry `/hermes-plugins/<op>`. Never assume one carrier.

`PluginInfo`:

```jsonc
{
  "name": "office-3d",        // from plugin.yaml name (fallback: dir name)
  "label": "Office 3D",       // from plugin.yaml label (fallback: name)
  "version": "1.3.0",
  "description": "...",
  "author": "oslook",
  "license": "MIT",
  "kind": "standalone",
  "platforms": ["linux", "macos"],
  "providesTools": ["office_status"],
  "requiresHermes": ">=0.20.0",
  "dir": "/abs/path/to/installed/plugin",
  "hasDesktop": true,          // desktop/plugin.js exists
  "hasBackend": true,          // dashboard/manifest.json + api file exist
  "backendApi": "plugin_api.py",
  "installedAt": 1730000000000,
  "source": "/Users/.../hermes-desktop-plugin-office-3d",  // where it came from
  "error": null                // string when the manifest could not be read
}
```

Install semantics: `source` may be an absolute local directory or a
`git+https://... | https://github.com/owner/repo(.git)` URL. Local directory →
recursive copy into `<store>/<name>/`; git URL → `git clone --depth 1` into a temp
dir then copy. Refuse when the target exists and `overwrite` is not true. Validate
that the source looks like a hermes plugin (`plugin.yaml` or `desktop/plugin.js`
present) before copying. Never copy `.git`, `node_modules`, `tests`, `docs`,
`__pycache__` or files > 2 MiB.

Store default: `~/.dsh/hermes-plugins` (config override `storeDir`); also report
plugins detected in `~/.hermes/plugins/<name>` as available-but-not-installed
(read-only; do not copy them automatically).

## B. Backend sidecar (host-dev)

`lib/backend.js` starts one Python process per plugin on demand:

```
python3 <packageDir>/lib/sidecar.py --plugin-dir <dir> --api-file plugin_api.py
```

`lib/sidecar.py` (owned by host-dev, lives in `lib/`):
- `sys.path.insert(0, pluginDir); sys.path.insert(0, pluginDir/dashboard)`
- import the module named by `manifest.json`'s `api` (default `plugin_api.py`) as
  `plugin_api`, read `router`
- `app = FastAPI(); app.include_router(router)`; add `GET /__health`
- run `uvicorn` on a **Unix domain socket** in a temp dir (fall back to an
  ephemeral `127.0.0.1` port when AF_UNIX is unavailable) and print one line
  `{"ready":true,"socket":"/path/sock"}` (or `{"ready":true,"port":N}`) to stdout
- exit 0 on SIGTERM; log errors to stderr

Host proxies `ANY /hermes-plugins/api/backend/<plugin>/<rest>` to
`http://<socket or host>/<rest>` and streams the response back. Idle shutdown
after 120 s with no request. If the plugin has no backend half → `{ ok:false,
error:'no backend half' }` with HTTP 400.

## C. Agent tools (host-dev)

Registered through `ctx.tools.register(...)`:

- `hermes_plugin_list` — no args → same data as `api/list` (text summary + JSON).
- `hermes_plugin_install` — `{ source: string, overwrite?: boolean }` → install result.
- `hermes_plugin_remove` — `{ name: string }`.
- `hermes_plugin_backend` — `{ name: string, path: string, method?: 'GET'|'POST', body?: object }`
  → calls the sidecar (starts it if needed) and returns the JSON body. This is how
  the model can read live data a hermes plugin exposes (e.g. office-3d `/state`).

All tool results are JSON-serializable text. Failures return the `error` string,
never throw.

## D. Client page (client-dev)

`client.js` is a **classic** script body inside
`window.__ModuleLoader__.load({ id: 'dsh-hermes-plugin-host', factory(require) {...} })`.
Inside the factory:

1. `const React = require('react')`.
2. `apply(ctx)` must register:
   - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'hermes-plugins', order: 210, label: 'Hermes Plugins' }, SidebarEntry))`
     (verify exact registration/props shape with `cordis_inspect_query` `Slots.listSubTree`
     for `sidebar.panellist` and `main` before writing; adapt if the shape differs)
   - the page itself into `main` with `key: 'hermes-plugins'`.
   - The sidebar entry must make the shell show the page; if `sidebar.panellist`
     cannot dispatch `main`, use whatever the shipped Plugins/Design-Canvas panel
     entries use (inspect their registration) — a reachable page is required.
3. Page renders a self-contained view: header ("Hermes Plugins"), the installed
   plugin list with label/version/description/badges, install input (absolute path
   or git URL) + Install button, per-row Run / Stop / Reload / Uninstall, and the
   running plugin's UI full-width below.
4. "Run" flow:
   ```js
   const runtimeSrc = await getText('/hermes-plugins/api/module?name=runtime')
   const sdkSrc     = await getText('/hermes-plugins/api/module?name=sdk')
   const css        = await getText('/hermes-plugins/api/module?name=sdk.css')
   // inject css once via a <style data-hermes-sdk> element owned by ctx.effect
   window.__dshHermesReact = React
   const { createHermesRuntime } = await importBlob(runtimeSrc)
   const { createSdk } = await importBlob(sdkSrc)
   const runtime = createHermesRuntime({ React, createSdk })
   const instance = await runtime.load(pluginInfo)   // fetches api/source itself? No — pass source:
   const instance = await runtime.load(pluginInfo, sourceText)
   ```
   `importBlob(src)` = `import(URL.createObjectURL(new Blob([src], {type:'text/javascript'})))`.
5. Render `React.createElement(instance.Root)` wrapped in an error boundary that
   shows the thrown message (a hermes plugin crash must never blank the page).
   On plugin switch / page leave, call `instance.dispose()`.
6. All visible text goes through the Client locale service if one is available via
   slot props/`ctx`; fall back to literal English. Do not touch `document.body`.

Styling: theme tokens `--dsw-alias-*` (query `Theme.listTokens`), no external CSS
deps, no Tailwind. Match the Plugin Manager page's list/row patterns.

## E. Runtime contract (client-dev ↔ runtime-dev)

`web/runtime.js` (browser ESM, **no imports at all** — bundled by blob import):

```js
export function createHermesRuntime({ React, createSdk })
// → {
//      async load(pluginInfo, sourceText): Promise<Instance>,
//    }
```

`Instance`:

```ts
{
  id: string                      // pluginInfo.name
  info: PluginInfo
  Root: React.ComponentType<{}>   // renders the plugin's own surfaces + in-page nav
  routes: { path: string, label?: string }[]
  statusBar: unknown[]            // registrations for STATUSBAR_AREAS
  palette: unknown[]
  keybinds: unknown[]
  settings: unknown[]             // registerSettingsPage results
  dispose(): void
}
```

`web/sdk.js` (browser ESM, **no imports at all**):

```js
export function createSdk({ React, api })
// → { sdk, AREAS }  where `sdk` has every named export the hermes plugin source
//   imports from '@hermes/plugin-sdk', and AREAS = the area constants.
```

`api` is supplied by `runtime.js`: `{ rest(pluginName, path, init?) → Promise<any>,
storage(pluginName) → { get(key, dflt), set(key, value), delete(key) } }`.

`runtime.js` responsibilities:
- build three blob modules: React (`globalThis.__dshHermesReact`), `react/jsx-runtime`
  (from `React.createElement`/`Fragment`), and the SDK namespace from `createSdk`.
- fetch-free: it receives `sourceText`; it rewrites `from '@hermes/plugin-sdk'`,
  `from 'react'`, `from 'react/jsx-runtime'` in the source to those blob URLs,
  then `await import(blobUrl)`.
- call `default.register(ctx)` where `ctx` implements `register`, `storage`,
  `rest`, `registerSettingsPage`; collect registrations by area.
- provide the SDK's `host` object: `navigate` (switch in-page route),
  `notify`/`notifyError` (toast queue exposed on Instance), `newChat`,
  `openSession`, `request` (no-op stubs that notify "not available in DSH").
- `useQuery` with a shared per-plugin cache keyed by `JSON.stringify(queryKey)`:
  poll with `refetchInterval` (number OR function), honour `refetchOnWindowFocus`,
  expose `{ data, isLoading, isError, error, refetch, isFetching }`.
- `Root` renders: in-page nav tabs (when >1 route), the active route's `render()`,
  a toast stack, and an uncaught-error panel instead of crashing.

`web/sdk.css` must make hermes-plugin markup look right: it must cover the
Tailwind utility classes the plugin sources actually use (grep
`~/Documents/GitHub/hermes-desktop-plugin-office-3d/desktop/plugin.js` for
`className` strings and support the real set: flex/grid/spacing/size/typography/
rounded/border/overflow/position utilities, `text-[var(--ui-*)]`, `gap-*`) plus
styles for the shim components (`hph-*` prefixed). Scope plugin utilities under
`.hph-root` where practical; map `--ui-text-primary|secondary|tertiary`,
`--ui-bg-*`, `--ui-border-*` onto `--dsw-alias-*`.

## F. Verify

1. `plugin_manager` `install_bundle` with `target` = the package directory (needs
   the user's approval — lead only).
2. `cordis_inspect_query` confirms the rows; then open the page in the real UI and
   install + run `office-3d` from
   `/Users/jkneen/Documents/GitHub/hermes-desktop-plugin-office-3d`.
3. Success = the Office 3D page renders (desks, stat chips) with live data from the
   Python backend (`/state`), plus the plugin list shows it installed.
