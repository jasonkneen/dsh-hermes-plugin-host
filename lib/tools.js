/**
 * Agent tools for the Hermes Plugin Host.
 *
 * Four tools, registered through `ctx.tools.register` in the agent scope:
 *
 *   hermes_plugin_list      installed Hermes plugins (same payload as `api/list`)
 *   hermes_plugin_install   install from an absolute directory or a git URL
 *   hermes_plugin_remove    uninstall one plugin by name
 *   hermes_plugin_backend   call a plugin's Python backend (starting its sidecar)
 *
 * `hermes_plugin_backend` is how the model reads live data a Hermes plugin
 * exposes — for office-3d that is `GET /state`, which returns the per-profile
 * office snapshot the desktop UI draws.
 *
 * Every `execute` resolves; failures come back as `{ ok: false, error }` values
 * rather than throwing, so one broken plugin can never fail the agent turn.
 *
 * @module hermes-plugin-host/tools
 */
const textBlock = (text) => [{ type: 'text', text: String(text ?? '') }]

const objectSchema = (properties, required) => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
})

/**
 * Schema for a tool RESULT envelope.
 *
 * Result values come from the shared operation layer, which deliberately returns
 * more than the model needs (for example `list` also carries `webAssets` and
 * `indexEntries` so the browser half can diagnose a broken store). The Harness
 * validates every tool result against this schema and REJECTS the whole call on
 * an undeclared property, so a result envelope must stay open: the declared
 * properties document the useful fields and extras pass through.
 */
const resultSchema = (properties, required) => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
  additionalProperties: true,
})

const PLUGIN_SCHEMA = resultSchema(
  {
    name: { type: 'string', description: 'Plugin id (from plugin.yaml).' },
    label: { type: 'string' },
    version: { type: 'string' },
    description: { type: 'string' },
    author: { type: 'string' },
    license: { type: 'string' },
    kind: { type: 'string' },
    platforms: { type: 'array', items: { type: 'string' } },
    providesTools: { type: 'array', items: { type: 'string' } },
    requiresHermes: { type: 'string' },
    dir: { type: 'string', description: 'Absolute path of the installed copy.' },
    hasDesktop: { type: 'boolean', description: 'desktop/plugin.js is present.' },
    hasBackend: { type: 'boolean', description: 'dashboard/manifest.json and its api file are present.' },
    backendApi: { type: 'string' },
    installedAt: { type: 'integer' },
    source: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    warnings: { type: 'array', items: { type: 'string' } },
    error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  ['name', 'label', 'dir'],
)

const jsonValueSchema = { description: 'JSON returned by the plugin backend, or raw text when it is not JSON.' }

/**
 * Turn a thrown error into a serialisable failure value.
 * @returns `{ ok: false, error }` with the HTTP status when it had one.
 */
export function failure(error) {
  const message = String(error?.message ?? error ?? 'unknown error')
  const status = Number(error?.status ?? error?.statusCode)
  return Number.isFinite(status) && status > 0 ? { ok: false, error: message, status } : { ok: false, error: message }
}

/**
 * Build the four tool definitions.
 *
 * @param options.operations - the shared operation layer from `lib/routes.js`.
 * @param options.log - diagnostic sink.
 * @returns a `ToolDefinition[]` ready for `ctx.tools.register`.
 */
export function createToolDefinitions({ operations, log = () => {} }) {
  const list = {
    name: 'hermes_plugin_list',
    description:
      "List the Hermes Desktop plugins installed in this DeepSeek Harness: each plugin's name, label, version, description, whether it has a desktop (browser UI) half and a Python backend half, and where it lives. Also reports any plugins Hermes Desktop itself has under ~/.hermes/plugins that are not installed here. Call this before installing, running, removing, or reading a plugin's backend data so you use a real name.",
    parameters: objectSchema({}),
    output: {
      schema: resultSchema(
        {
          ok: { type: 'boolean' },
          store: { type: 'string', description: 'Absolute registry directory.' },
          hermesHome: { type: 'string' },
          plugins: { type: 'array', items: PLUGIN_SCHEMA },
          available: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
        ['ok'],
      ),
      render: (_args, value) => {
        if (!value || value.ok !== true) return textBlock(`Could not list Hermes plugins: ${value?.error ?? 'unknown error'}`)
        const plugins = Array.isArray(value.plugins) ? value.plugins : []
        if (plugins.length === 0) {
          return textBlock(
            `No Hermes plugins are installed in ${value.store ?? 'the store'} yet. Install one with hermes_plugin_install and a local directory or git URL.`,
          )
        }
        const rows = plugins.map((plugin) => {
          const halves = [plugin.hasDesktop ? 'desktop UI' : null, plugin.hasBackend ? 'python backend' : null].filter(Boolean)
          const version = plugin.version ? ` v${plugin.version}` : ''
          const halvesText = halves.length > 0 ? ` — ${halves.join(' + ')}` : ' — no runnable half'
          const trouble = plugin.error ? ` ⚠ ${plugin.error}` : ''
          return `- ${plugin.name}${version}: ${plugin.label}${halvesText}${trouble}`
        })
        const available = Array.isArray(value.available) ? value.available : []
        const availableText =
          available.length > 0
            ? `\n\nHermes Desktop also has ${available.length} plugin${available.length === 1 ? '' : 's'} under ~/.hermes/plugins that ${available.length === 1 ? 'is' : 'are'} not installed here: ${available.map((entry) => entry.name).join(', ')}.`
            : ''
        return textBlock(`Installed Hermes plugins (${plugins.length}) in ${value.store}:\n${rows.join('\n')}${availableText}`)
      },
    },
    isConcurrencySafe: () => true,
    execute: async () => {
      try {
        return await operations.run('list')
      } catch (error) {
        log(`hermes_plugin_list failed: ${error?.message ?? error}`)
        return failure(error)
      }
    },
  }

  const install = {
    name: 'hermes_plugin_install',
    description:
      'Install a Hermes Desktop plugin into this DeepSeek Harness from a local directory or a git URL (for example /Users/me/GitHub/hermes-desktop-plugin-office-3d or https://github.com/owner/hermes-desktop-plugin-x). The source must contain plugin.yaml or desktop/plugin.js. The plugin is copied, minus .git, node_modules, tests, docs and files over 2 MiB, into ~/.dsh/hermes-plugins/<name>. Refuses to replace an installed plugin unless overwrite is true. After installing, the user can open it in the Hermes Plugins page; use hermes_plugin_backend to read data from its Python half.',
    parameters: objectSchema(
      {
        source: { type: 'string', description: 'Absolute path to a local Hermes plugin directory, or a git+https/https git URL.' },
        name: { type: 'string', description: 'Optional install name override (defaults to plugin.yaml name, then the directory name).' },
        overwrite: { type: 'boolean', description: 'Replace an already-installed plugin of the same name.' },
      },
      ['source'],
    ),
    output: {
      schema: resultSchema(
        {
          ok: { type: 'boolean' },
          plugin: PLUGIN_SCHEMA,
          error: { type: 'string' },
        },
        ['ok'],
      ),
      render: (_args, value) => {
        if (!value || value.ok !== true) return textBlock(`Install failed: ${value?.error ?? 'unknown error'}`)
        const plugin = value.plugin ?? {}
        return textBlock(
          `Installed ${plugin.name ?? 'the plugin'}${plugin.version ? ` v${plugin.version}` : ''} into ${plugin.dir ?? 'the store'}. Desktop half: ${plugin.hasDesktop ? 'yes' : 'no'}; Python backend: ${plugin.hasBackend ? `yes (${plugin.backendApi})` : 'no'}.`,
        )
      },
    },
    execute: async (args) => {
      try {
        const input = typeof args === 'object' && args !== null ? args : {}
        return await operations.run('install', {
          source: input.source,
          name: input.name,
          overwrite: input.overwrite === true,
        })
      } catch (error) {
        log(`hermes_plugin_install failed: ${error?.message ?? error}`)
        return failure(error)
      }
    },
  }

  const remove = {
    name: 'hermes_plugin_remove',
    description:
      'Uninstall a Hermes Desktop plugin from this DeepSeek Harness by name, deleting its copy under ~/.dsh/hermes-plugins and stopping its Python backend if it was running. Use hermes_plugin_list first to get the exact name.',
    parameters: objectSchema({ name: { type: 'string', description: 'Plugin name exactly as hermes_plugin_list reports it.' } }, ['name']),
    output: {
      schema: resultSchema(
        {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          dir: { type: 'string' },
          error: { type: 'string' },
        },
        ['ok'],
      ),
      render: (_args, value) => {
        if (!value || value.ok !== true) return textBlock(`Remove failed: ${value?.error ?? 'unknown error'}`)
        return textBlock(`Removed the Hermes plugin ${value.name}.`)
      },
    },
    execute: async (args) => {
      try {
        const input = typeof args === 'object' && args !== null ? args : {}
        return await operations.run('remove', { name: input.name })
      } catch (error) {
        log(`hermes_plugin_remove failed: ${error?.message ?? error}`)
        return failure(error)
      }
    },
  }

  const backendTool = {
    name: 'hermes_plugin_backend',
    description:
      "Call the Python backend half of an installed Hermes plugin and return its JSON response; this is how to read the live data a plugin exposes. For office-3d, GET /state returns one entry per Hermes profile with online/busy state, active sessions, token and cost totals — the same data its Office 3D view draws. The backend process starts on first use (allow a few seconds) and stops itself after two idle minutes. A plugin without a backend half returns an error.",
    parameters: objectSchema(
      {
        name: { type: 'string', description: 'Installed plugin name, e.g. office-3d.' },
        path: { type: 'string', description: 'Backend API path, e.g. /state (leading slash optional).' },
        method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP method; defaults to GET.' },
        body: { type: 'object', additionalProperties: true, description: 'JSON body for POST requests.' },
        source: {
          type: 'string',
          enum: ['hermes', 'dsh'],
          description: 'One-call override of this plugin\'s data source: "hermes" reads the Hermes Python backend, "dsh" answers GET /state from the Harness adapter. Omit to use the persisted setting.',
        },
      },
      ['name', 'path'],
    ),
    output: {
      schema: resultSchema(
        {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          path: { type: 'string' },
          status: { type: 'integer' },
          data: jsonValueSchema,
          error: { type: 'string' },
        },
        ['ok'],
      ),
      render: (args, value) => {
        if (!value || value.ok !== true) {
          return textBlock(`Backend call failed${args?.name ? ` for ${args.name}` : ''}: ${value?.error ?? 'unknown error'}`)
        }
        let body
        try {
          body = JSON.stringify(value.data)
        } catch {
          body = String(value.data)
        }
        if (body.length > 20_000) body = `${body.slice(0, 20_000)}… (truncated)`
        return textBlock(`GET ${value.path} → ${value.status}\n${body}`)
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const input = typeof args === 'object' && args !== null ? args : {}
      const name = typeof input.name === 'string' ? input.name : ''
      const path = typeof input.path === 'string' ? input.path : ''
      try {
        const result = await operations.run(
          'backend',
          { name, path, method: input.method, body: input.body, source: input.source },
          'GET',
        )
        let data
        try {
          data = JSON.parse(result.text)
        } catch {
          data = result.text
        }
        return {
          ok: result.status >= 200 && result.status < 300,
          name,
          path,
          status: result.status,
          data,
          ...(result.status >= 200 && result.status < 300 ? {} : { error: `backend responded with HTTP ${result.status}` }),
        }
      } catch (error) {
        log(`hermes_plugin_backend failed: ${error?.message ?? error}`)
        return failure(error)
      }
    },
  }

  const dataSource = {
    name: 'hermes_plugin_data_source',
    description:
      'Read or set which data source drives an installed Hermes plugin\'s status view. "hermes" (default) makes the plugin read Hermes Desktop profiles through its own Python backend; "dsh" makes GET /state answer from this DeepSeek Harness instead (workspaces and sessions become the desks, live agents become the busy ones), with the plugin untouched. Omit source to read the current setting. The choice is persisted per plugin across restarts.',
    parameters: objectSchema(
      {
        name: { type: 'string', description: 'Installed plugin name, e.g. office-3d.' },
        source: { type: 'string', enum: ['hermes', 'dsh'], description: 'New source to persist; omit to read the current one.' },
      },
      ['name'],
    ),
    output: {
      schema: resultSchema(
        {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          source: { type: 'string', enum: ['hermes', 'dsh'] },
          error: { type: 'string' },
        },
        ['ok'],
      ),
      render: (args, value) => {
        if (!value || value.ok !== true) {
          return textBlock(`Data source call failed${args?.name ? ` for ${args.name}` : ''}: ${value?.error ?? 'unknown error'}`)
        }
        const changed = typeof args?.source === 'string' && args.source !== ''
        const what = value.source === 'dsh' ? 'this DeepSeek Harness (workspaces and live agents as desks)' : 'Hermes Desktop profiles through the plugin\'s own Python backend'
        return textBlock(`${changed ? 'Set' : 'Data source for'} ${value.name}: ${value.source} — ${what}.`)
      },
    },
    execute: async (args) => {
      try {
        const input = typeof args === 'object' && args !== null ? args : {}
        return await operations.run('data-source', { name: input.name, source: input.source })
      } catch (error) {
        log(`hermes_plugin_data_source failed: ${error?.message ?? error}`)
        return failure(error)
      }
    },
  }

  return [list, install, remove, backendTool, dataSource]
}

/**
 * Register the tool definitions, retrying briefly so an HMR reload that
 * duplicates a registration does not lose the tools.
 *
 * @param ctx - owning Host context.
 * @param definitions - result of `createToolDefinitions`.
 * @param registerWithRetry - shared retrying disposer helper.
 * @param log - diagnostic sink.
 * @returns the number of tools registered (attempted).
 */
export function registerTools(ctx, definitions, registerWithRetry, log = () => {}) {
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    log('no tool registry available; the Hermes plugin tools stay unregistered')
    return 0
  }
  let count = 0
  for (const definition of definitions) {
    ctx.effect(
      () => registerWithRetry(() => tools.register(definition), `the tool ${definition.name}`),
      `hermes-plugin-host: tool ${definition.name}`,
    )
    count += 1
  }
  log(`registered ${count} hermes plugin tools`)
  return count
}
