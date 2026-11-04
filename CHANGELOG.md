# Changelog

## 1.0.0

First publishable release.

- **Install and run Hermes Desktop plugins** inside a DeepSeek Harness profile.
  The Hermes plugin is never modified: its browser half runs against an
  `@hermes/plugin-sdk` shim, its Python half runs under a managed FastAPI
  sidecar, and `ctx.rest('/state')` is answered by either the plugin's own
  backend or a Harness adapter.
- **Two views**, matching the shipped Plugins page: a management page (browse,
  install from a path or git URL, uninstall) and one first-class sidebar panel
  per installed plugin.
- **Data sources per plugin**: `hermes` (the plugin's own profiles) or `dsh`
  (this Harness's workspaces and live agents), switchable in the row and
  persisted; `windowDays`/`maxDesks` curate how many desks are drawn.
- **Agent tools**: `hermes_plugin_list`, `hermes_plugin_install`,
  `hermes_plugin_remove`, `hermes_plugin_backend`, `hermes_plugin_data_source`.
- **Boot safety**: `dsh.client` is not `immediately`, `inject` carries only
  proven dependencies, optional services are read through `ctx.get`, and
  `apply` is contained on both halves, so a fault degrades a feature instead of
  failing the desktop web boot into safe mode.

Known limitations: the plugin's agent half (`__init__.py`) is not executed;
`host.newChat`/`openSession` map to Harness sessions while other Hermes RPCs
toast as unavailable; tokens are counted for live sessions only and cost is
always 0 (the Harness has no cost model); Windows is unsupported.
