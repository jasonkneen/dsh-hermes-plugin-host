# Hermes Plugin Host — for DeepSeek Harness

Install and **run Hermes Desktop plugins** inside DeepSeek Harness.

A Hermes Desktop plugin is a folder like
[`hermes-desktop-plugin-office-3d`](https://github.com/oslook/hermes-desktop-plugin-office-3d):
`plugin.yaml` plus a `desktop/plugin.js` (one ESM file that calls
`register(ctx)` against `@hermes/plugin-sdk`) and optionally a Python
`dashboard/plugin_api.py` FastAPI router. This bundle gives the Harness the two
things hermes had: a **place to install them** and a **runtime that executes
them**.

## What you get

- **Hermes Plugins page** — a sidebar panel (key `hermes-plugins`) listing every
  installed plugin with its label, version, description, and which halves it
  ships.
- **Install / uninstall** — from an absolute directory or a git URL, into
  `~/.dsh/hermes-plugins/<name>/`. Nothing is downloaded unless you ask.
- **Run** — the plugin's `desktop/plugin.js` is loaded in the browser against a
  faithful `@hermes/plugin-sdk` shim: `atom`/`useValue`, `useQuery` with polling,
  `host.*`, `ctx.register`, `ctx.rest`, `ctx.storage`, the area constants, and the
  SDK's UI components. The plugin's page renders full-width in the panel with
  its in-page navigation.
- **Backend halves** — a plugin's `dashboard/plugin_api.py` is served by a lazily
  started Python FastAPI sidecar (`uvicorn`), so `ctx.rest('/state')` returns
  real data. Idle sidecars are reaped.
- **Agent tools** — `hermes_plugin_list`, `hermes_plugin_install`,
  `hermes_plugin_remove`, `hermes_plugin_backend`, so the model can install a
  plugin and read the live data it exposes without the UI.

## Install

A bundle, not a library: install it into a Harness profile and it adds a **Hermes
Plugins** page plus one sidebar panel per installed Hermes plugin.

**From GitHub** (recommended while the package is unpublished):

```
plugin_manager install_bundle target="git+https://github.com/jasonkneen/dsh-hermes-plugin-host"
```

or from a shell, for a named profile:

```
dsh plugin --profile desktop add git+https://github.com/jasonkneen/dsh-hermes-plugin-host
```

**From a release tarball**: attach the `npm pack` output to a GitHub release and
pass its path or URL to `install_bundle` as `target`.

**From a local checkout** (development): pass the absolute directory; the profile
gets a `link:` dependency, so edits apply without reinstalling.

Installing enables the bundle by default. Then open **Hermes Plugins** in the
sidebar and install a Hermes plugin, for example
`/Users/you/Documents/GitHub/hermes-desktop-plugin-office-3d`, and press Install.

## Compatibility

`engines.dsh` declares `>=0.2.1-rc.5`; the package manager checks it before a
registry or path install and reports `incompatible-version` instead of loading a
bundle that cannot work. For a git or tarball install the same check runs after
download, and the profile is restored if it refuses. A deliberate override is
`plugin_manager` `set_version_exemption` (`--accept-risk`).

## Packaging

No build step and no runtime dependencies: plain ESM plus static assets.

```
npm pack --dry-run     # inspect exactly what ships
npm pack               # dsh-hermes-plugin-host-1.0.0.tgz
```

Layout that matters to the Loader: `index.js` (Host row, `apply(ctx, config)`),
`cordis.patch.yml` (`dsh.bundle.patch` — its row `name` must equal the package
name), `client.js` (browser half; its `__ModuleLoader__.load({ id })` must also
equal the package name), `web/**` (served to the browser at runtime, so it must
ship), `locale/*.json` and `icon.svg` (Plugin Manager display metadata).

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Host row: tools, `/api/hermes-plugins/*` routes, prompt section |
| `lib/registry.js` | Manifest parsing, install/copy/remove, store scanning |
| `lib/routes.js` | Route handlers shared by both carriers |
| `lib/backend.js` | Python FastAPI sidecar manager + proxy |
| `lib/sidecar.py` | Runs one plugin's `plugin_api.py` router under uvicorn |
| `client.js` | Browser row: the Hermes Plugins page and run flow |
| `web/runtime.js` | Hermes plugin loader: specifier rewrite, blob modules, surfaces |
| `web/sdk.js` | `@hermes/plugin-sdk` shim |
| `web/sdk.css` | Utilities + component styles for hermes plugin markup |
| `CONTRACT.md` | The exact interfaces between the halves |

## Limits

- The agent half (`__init__.py`, hermes *agent* tools such as `office_status`) is
  not executed — hermes' Python tool protocol is not the Harness one. The same
  data is reachable through `hermes_plugin_backend`.
- Hermes-only affordances degrade: `host.newChat`, `host.openSession` and
  `host.request` toast "not available in DeepSeek Harness" instead of throwing.
- `SIDEBAR_NAV_AREA`, `STATUSBAR_AREAS`, `PALETTE_AREA` and `KEYBINDS_AREA`
  registrations are rendered **inside** the plugin page (tabs/footer) rather than
  injected into Harness chrome.
- Windows is not supported (the hermes plugins themselves are POSIX-only).
