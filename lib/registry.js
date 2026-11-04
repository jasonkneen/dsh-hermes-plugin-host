/**
 * Hermes plugin registry: manifest parsing, scanning, install, remove and the
 * read paths the HTTP routes serve (`desktop/plugin.js` source and the browser
 * ES modules in this package's `web/` directory).
 *
 * A "Hermes plugin" is a directory laid out like
 * `hermes-desktop-plugin-office-3d`:
 *
 *   plugin.yaml            manifest (name, label, version, description, ...)
 *   desktop/plugin.js      desktop half (one ESM file)
 *   dashboard/manifest.json + dashboard/<api>.py   backend half (FastAPI)
 *   __init__.py            agent half (out of scope for v1)
 *
 * Everything here is defensive: a broken or partial plugin directory must
 * degrade to fallback values and never throw out of `scanPlugins`.
 *
 * @module hermes-plugin-host/registry
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  access,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants as FS_CONSTANTS } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_SOURCE, readDataSources } from './datasource.js'

const execFileAsync = promisify(execFile)

/** Absolute path of this package's root (`…/dsh-hermes-plugin-host`). */
export const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
/** Browser-side ES modules served through `api/module`. */
export const WEB_DIR = join(PACKAGE_DIR, 'web')

/** Default registry store; `~/.dsh/hermes-plugins`. */
export const DEFAULT_STORE_DIR = join(homedir(), '.dsh', 'hermes-plugins')
/** Where Hermes Desktop itself installs plugins (read-only reporting). */
export const HERMES_HOME = join(homedir(), '.hermes')
export const HERMES_PLUGINS_DIR = join(HERMES_HOME, 'plugins')

/** Directory/file names never copied into the store. */
const COPY_SKIP_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'tests',
  'docs',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.DS_Store',
])
/** Skip files/directories whose name starts with these prefixes. */
const COPY_SKIP_PREFIXES = ['.staging-', '.tmp-', '.plugin-host-index']
/** Contract cap: no single file larger than 2 MiB is copied. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Instruction-file cap for `desktop/plugin.js` served to the browser. */
const INDEX_FILE = '.plugin-host-index.json'
const GIT_CLONE_TIMEOUT_MS = 120_000

const MODULE_FILES = {
  runtime: { file: 'runtime.js', contentType: 'text/javascript; charset=utf-8' },
  sdk: { file: 'sdk.js', contentType: 'text/javascript; charset=utf-8' },
  'sdk.css': { file: 'sdk.css', contentType: 'text/css; charset=utf-8' },
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
export const asString = (value) => (typeof value === 'string' ? value : '')

/** Strip one layer of YAML quoting and inline comments from a scalar. */
function parseScalar(raw) {
  let value = String(raw ?? '').trim()
  if (value === '') return ''
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  // An unquoted scalar ends at a ` #` comment introducer.
  const comment = value.search(/\s#/)
  if (comment !== -1) value = value.slice(0, comment).trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null' || value === '~') return null
  return value
}

/** Parse a YAML flow sequence such as `[linux, macos]` or `["a", 'b']`. */
function parseFlowSequence(raw) {
  const inner = raw.slice(1, -1).trim()
  if (inner === '') return []
  const items = []
  let buffer = ''
  let quote = ''
  for (const char of inner) {
    if (quote) {
      buffer += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
      continue
    }
    if (char === ',') {
      items.push(parseScalar(buffer))
      buffer = ''
      continue
    }
    buffer += char
  }
  if (buffer.trim() !== '') items.push(parseScalar(buffer))
  return items
}

/**
 * Parse the small YAML subset Hermes plugin manifests actually use.
 *
 * Supported: `key: scalar`, single- and double-quoted scalars, `#` comments,
 * folded (`>-`, `>`) and literal (`|`, `|-`) block scalars, flow sequences
 * (`platforms: [linux, macos]`) and block sequences (`- item`). Nested mappings
 * are collected one level deep. Unknown constructs are ignored rather than
 * throwing: every caller has a fallback for a missing field.
 *
 * @param text - raw `plugin.yaml` contents.
 * @returns a plain object of top-level keys.
 */
export function parsePluginYaml(text) {
  const result = {}
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  let index = 0

  const indentOf = (line) => line.length - line.trimStart().length
  const isBlankOrComment = (line) => line.trim() === '' || line.trimStart().startsWith('#')

  while (index < lines.length) {
    const line = lines[index]
    if (isBlankOrComment(line)) {
      index += 1
      continue
    }
    const match = /^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/.exec(line)
    if (!match) {
      index += 1
      continue
    }
    const [, indentText, key, restRaw] = match
    const keyIndent = indentText.length
    const rest = restRaw.trim()
    index += 1

    // Folded / literal block scalar.
    if (rest === '>' || rest === '>-' || rest === '>+' || rest === '|' || rest === '|-' || rest === '|+') {
      const folded = rest.startsWith('>')
      const collected = []
      while (index < lines.length) {
        const candidate = lines[index]
        if (candidate.trim() === '') {
          collected.push('')
          index += 1
          continue
        }
        if (indentOf(candidate) <= keyIndent) break
        collected.push(candidate)
        index += 1
      }
      const nonEmpty = collected.filter((entry) => entry.trim() !== '')
      const baseIndent = nonEmpty.length > 0 ? Math.min(...nonEmpty.map(indentOf)) : 0
      const normalized = collected.map((entry) => (entry.trim() === '' ? '' : entry.slice(baseIndent)))
      while (normalized.length > 0 && normalized[normalized.length - 1] === '') normalized.pop()
      result[key] = folded
        ? normalized.reduce((acc, entry) => (entry === '' ? `${acc}\n` : acc === '' || acc.endsWith('\n') ? acc + entry : `${acc} ${entry}`), '').trim()
        : normalized.join('\n').trim()
      continue
    }

    // Flow sequence on the key line.
    if (rest.startsWith('[') && rest.endsWith(']')) {
      result[key] = parseFlowSequence(rest)
      continue
    }

    // Bare value: either a block sequence, a nested mapping, or null.
    if (rest === '') {
      const items = []
      const nested = {}
      let sawNested = false
      let consumed = 0
      while (index + consumed < lines.length) {
        const candidate = lines[index + consumed]
        if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) {
          consumed += 1
          continue
        }
        if (indentOf(candidate) <= keyIndent) break
        const listItem = /^\s*-\s+(.*)$/.exec(candidate)
        if (listItem) {
          items.push(parseScalar(listItem[1]))
          consumed += 1
          continue
        }
        const nestedPair = /^\s*([A-Za-z0-9_.\-]+)\s*:\s*(.*)$/.exec(candidate)
        if (nestedPair) {
          sawNested = true
          nested[nestedPair[1]] = parseScalar(nestedPair[2])
          consumed += 1
          continue
        }
        break
      }
      index += consumed
      if (items.length > 0) result[key] = items
      else if (sawNested) result[key] = nested
      else result[key] = null
      continue
    }

    result[key] = parseScalar(rest)
  }

  return result
}

/** Resolve the configured store directory, expanding a leading `~`. */
export function resolveStoreDir(config) {
  const configured = asString(config?.storeDir).trim()
  if (!configured) return DEFAULT_STORE_DIR
  const expanded = configured === '~' ? homedir() : configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : configured
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

/** True when `path` exists and is a directory. */
export async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** True when `path` exists and is a regular file. */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Join `segments` onto `root` and prove the result stays inside `root`.
 * Every user-supplied path fragment goes through here.
 *
 * @throws when the resolved path escapes `root`.
 */
export function resolveInside(root, ...segments) {
  const base = resolve(root)
  const target = resolve(base, ...segments)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('path escapes the plugin directory')
  }
  return target
}

/** Normalise a plugin name into one safe directory segment. */
export function safeDirName(value) {
  const raw = asString(value).trim()
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/u, '').replace(/[-.]+$/u, '')
  return cleaned === '' ? 'plugin' : cleaned.slice(0, 80)
}

/**
 * Read `plugin.yaml` from a plugin directory.
 * @returns `{ fields, error }` — `fields` is `{}` and `error` a message when absent/broken.
 */
export async function readManifest(dir) {
  const manifestPath = join(dir, 'plugin.yaml')
  let text
  try {
    text = await readFile(manifestPath, 'utf8')
  } catch (error) {
    return { fields: {}, error: error?.code === 'ENOENT' ? 'plugin.yaml not found' : `plugin.yaml unreadable: ${error?.message ?? error}` }
  }
  try {
    const fields = parsePluginYaml(text)
    return { fields: isObject(fields) ? fields : {}, error: null }
  } catch (error) {
    return { fields: {}, error: `plugin.yaml could not be parsed: ${error?.message ?? error}` }
  }
}

/** Read `dashboard/manifest.json`; `null` when absent or broken. */
export async function readBackendManifest(dir) {
  const path = join(dir, 'dashboard', 'manifest.json')
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Derive a backend description: manifest presence plus the resolved API module.
 * @returns `{ hasBackend, backendApi, manifestFile, apiPath }`
 */
export async function describeBackend(dir) {
  const backendManifest = await readBackendManifest(dir)
  const api = asString(backendManifest?.api).trim() || 'plugin_api.py'
  const manifestFile = join(dir, 'dashboard', 'manifest.json')
  const hasManifest = await isFile(manifestFile)
  let apiPath = null
  try {
    apiPath = resolveInside(dir, 'dashboard', api)
  } catch {
    apiPath = null
  }
  const hasApi = apiPath ? await isFile(apiPath) : false
  return {
    hasBackend: hasManifest && hasApi,
    hasManifest,
    backendApi: api,
    apiPath: hasApi ? apiPath : null,
    backendManifest,
  }
}

/* -------------------------------------------------------------------------- */
/* PluginInfo                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the `PluginInfo` the client and the tools both consume.
 *
 * @param dir - absolute plugin directory.
 * @param options.source - where this copy came from (install source).
 * @param options.installedAt - epoch ms of installation.
 * @param options.dataSource - which data source `/state` uses (`hermes` or `dsh`).
 * @returns a fully-populated `PluginInfo`; never throws.
 */
export async function readPluginInfo(dir, options = {}) {
  const dirName = basename(resolve(dir))
  const { fields, error } = await readManifest(dir)
  const name = asString(fields.name).trim() || dirName
  const label = asString(fields.label).trim() || name
  const platforms = Array.isArray(fields.platforms)
    ? fields.platforms.map((entry) => asString(entry).trim()).filter(Boolean)
    : []
  const providesTools = Array.isArray(fields.provides_tools)
    ? fields.provides_tools.map((entry) => asString(entry).trim()).filter(Boolean)
    : asString(fields.provides_tools).trim() !== ''
      ? [asString(fields.provides_tools).trim()]
      : []
  const backend = await describeBackend(dir)
  const hasDesktop = await isFile(join(dir, 'desktop', 'plugin.js'))
  let installedAt = typeof options.installedAt === 'number' && Number.isFinite(options.installedAt) ? options.installedAt : null
  if (installedAt === null) {
    try {
      installedAt = Math.round((await stat(dir)).mtimeMs)
    } catch {
      installedAt = 0
    }
  }
  const warnings = []
  if (error) warnings.push(error)
  if (!hasDesktop) warnings.push('no desktop/plugin.js')
  if (!backend.hasBackend) warnings.push('no backend half')
  return {
    name,
    label,
    version: asString(fields.version).trim(),
    description: asString(fields.description).trim(),
    author: asString(fields.author).trim(),
    license: asString(fields.license).trim(),
    kind: asString(fields.kind).trim() || 'standalone',
    platforms,
    providesTools,
    requiresHermes: asString(fields.requires_hermes ?? fields.requiresHermes).trim(),
    dir: resolve(dir),
    hasDesktop,
    hasBackend: backend.hasBackend,
    backendApi: backend.hasBackend ? backend.backendApi : '',
    installedAt,
    source: asString(options.source) || null,
    dataSource: asString(options.dataSource) || DEFAULT_SOURCE,
    warnings,
    error: error ?? null,
  }
}

/* -------------------------------------------------------------------------- */
/* Store + index                                                              */
/* -------------------------------------------------------------------------- */

/** Create the store directory (and any parent) when missing. */
export async function ensureStore(store) {
  await mkdir(store, { recursive: true })
  return store
}

function indexPath(store) {
  return join(store, INDEX_FILE)
}

/** Read the install-index (`name` → `{ installedAt, source }`); `{}` on failure. */
export async function readIndex(store) {
  try {
    const text = await readFile(indexPath(store), 'utf8')
    const parsed = JSON.parse(text)
    if (isObject(parsed) && isObject(parsed.plugins)) return parsed.plugins
  } catch {}
  return {}
}

async function writeIndex(store, plugins) {
  try {
    await ensureStore(store)
    await writeFile(indexPath(store), JSON.stringify({ version: 1, plugins }, null, 2), 'utf8')
  } catch {
    // A missing index only costs `source`/`installedAt` precision.
  }
}

async function updateIndexEntry(store, name, entry) {
  const index = await readIndex(store)
  if (entry === null) delete index[name]
  else index[name] = entry
  await writeIndex(store, index)
}

/**
 * List every plugin directory in the store.
 * @returns `PluginInfo[]` sorted by name; unreadable entries are reported with `error`.
 */
export async function scanPlugins(store) {
  let entries
  try {
    entries = await readdir(store, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const index = await readIndex(store)
  const dataSources = await readDataSources(store)
  const plugins = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || COPY_SKIP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
    const dir = join(store, entry.name)
    try {
      const meta = isObject(index[entry.name]) ? index[entry.name] : {}
      const info = await readPluginInfo(dir, {
        source: meta.source,
        installedAt: typeof meta.installedAt === 'number' ? meta.installedAt : undefined,
        dataSource: DEFAULT_SOURCE ?? DEFAULT_SOURCE,
      })
      // The source setting is keyed by plugin name (manifest name); fall back to
      // the directory name for a plugin whose manifest could not be read.
      info.dataSource = dataSources[info.name] ?? dataSources[entry.name] ?? DEFAULT_SOURCE
      plugins.push(info)
    } catch (error) {
      plugins.push({
        name: entry.name,
        label: entry.name,
        version: '',
        description: '',
        author: '',
        license: '',
        kind: 'standalone',
        platforms: [],
        providesTools: [],
        requiresHermes: '',
        dir,
        hasDesktop: false,
        hasBackend: false,
        backendApi: '',
        installedAt: 0,
        source: null,
        warnings: [],
        error: `plugin directory could not be read: ${error?.message ?? error}`,
      })
    }
  }
  plugins.sort((left, right) => left.name.localeCompare(right.name))
  return plugins
}

/** Plugins Hermes Desktop itself had installed; reported, never copied. */
export async function detectHermesPlugins() {
  let entries
  try {
    entries = await readdir(HERMES_PLUGINS_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(HERMES_PLUGINS_DIR, entry.name)
    try {
      const info = await readPluginInfo(dir)
      found.push({
        name: info.name,
        label: info.label,
        version: info.version,
        dir: info.dir,
        hasDesktop: info.hasDesktop,
        hasBackend: info.hasBackend,
        // Hermes agent-only plugins (`__init__.py` + plugin.yaml) have no UI
        // half and nothing this Harness could run, so `installable` is false.
        installable: info.hasDesktop,
        installed: false,
      })
    } catch {
      found.push({
        name: entry.name,
        label: entry.name,
        version: '',
        dir,
        hasDesktop: false,
        hasBackend: false,
        installable: false,
        installed: false,
      })
    }
  }
  found.sort((left, right) => left.name.localeCompare(right.name))
  return found
}

/**
 * Find one installed plugin by name (case-sensitive, then case-insensitive).
 * @returns `PluginInfo | null`
 */
export async function findPlugin(store, name) {
  const wanted = asString(name).trim()
  if (wanted === '') return null
  const plugins = await scanPlugins(store)
  const exact = plugins.find((plugin) => plugin.name === wanted)
  if (exact) return exact
  const lowered = wanted.toLowerCase()
  return plugins.find((plugin) => plugin.name.toLowerCase() === lowered) ?? null
}

/* -------------------------------------------------------------------------- */
/* Copy + install                                                             */
/* -------------------------------------------------------------------------- */

/** True when `dir` looks like a Hermes plugin: `plugin.yaml` or `desktop/plugin.js`. */
export async function looksLikeHermesPlugin(dir) {
  if (!(await isDirectory(dir))) return false
  return (await isFile(join(dir, 'plugin.yaml'))) || (await isFile(join(dir, 'desktop', 'plugin.js')))
}

/**
 * Recursively copy `source` into `target`, applying the contract's skip rules.
 * Symlinks are not followed (they could leave the plugin directory).
 *
 * @returns `{ copied: number, skipped: string[] }`
 */
export async function copyPluginTree(source, target) {
  const skipped = []
  let copied = 0
  await mkdir(target, { recursive: true })

  const walk = async (fromDir, toDir, relative) => {
    let entries
    try {
      entries = await readdir(fromDir, { withFileTypes: true })
    } catch (error) {
      skipped.push(`${relative || '.'}: unreadable (${error?.code ?? error?.message ?? error})`)
      return
    }
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name
      if (COPY_SKIP_NAMES.has(entry.name) || COPY_SKIP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
        skipped.push(`${rel}: excluded by copy rules`)
        continue
      }
      if (entry.isSymbolicLink()) {
        skipped.push(`${rel}: symlink not followed`)
        continue
      }
      const from = join(fromDir, entry.name)
      const to = join(toDir, entry.name)
      if (entry.isDirectory()) {
        await mkdir(to, { recursive: true })
        await walk(from, to, rel)
        continue
      }
      if (!entry.isFile()) {
        skipped.push(`${rel}: not a regular file`)
        continue
      }
      let size = 0
      try {
        size = (await stat(from)).size
      } catch {
        skipped.push(`${rel}: unreadable`)
        continue
      }
      if (size > MAX_FILE_BYTES) {
        skipped.push(`${rel}: ${size} bytes exceeds the 2 MiB cap`)
        continue
      }
      try {
        await cp(from, to)
        copied += 1
      } catch (error) {
        skipped.push(`${rel}: copy failed (${error?.message ?? error})`)
      }
    }
  }

  await walk(source, target, '')
  return { copied, skipped }
}

/** Run `git clone --depth 1` into a fresh temp dir; `{ dir, cleanup }`. */
async function cloneToTemp(url) {
  const parent = await mkdtempDir('hph-clone-')
  const dir = join(parent, 'repo')
  try {
    await execFileAsync('git', ['clone', '--depth', '1', url, dir], {
      timeout: GIT_CLONE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    await rm(parent, { recursive: true, force: true }).catch(() => {})
    const stderr = asString(error?.stderr).trim().split('\n').slice(-3).join(' ').trim()
    throw new Error(`git clone failed${stderr ? `: ${stderr}` : `: ${error?.message ?? error}`}`)
  }
  return {
    dir,
    cleanup: () => rm(parent, { recursive: true, force: true }).catch(() => {}),
  }
}

async function mkdtempDir(prefix) {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  return mkdtemp(join(tmpdir(), prefix))
}

/** Recognise a source string that should be cloned rather than copied. */
export function isGitSource(source) {
  return /^(git\+)?(https?:\/\/|file:\/\/|git@)/iu.test(asString(source).trim())
}

function stripGitPrefix(source) {
  return asString(source).trim().replace(/^git\+/iu, '')
}

/**
 * Install a Hermes plugin from a local directory or a Git URL.
 *
 * Local directory → recursive copy into `<store>/<name>/`.
 * Git URL → `git clone --depth 1` into a temp dir, then the same copy.
 * The copy lands in a staging directory and is renamed into place, so a failed
 * install never leaves a half-written plugin behind.
 *
 * @throws when the source is invalid, the target exists without `overwrite`, or
 *         the copy fails.
 */
export async function installPlugin({ store, source, name, overwrite = false }) {
  const requested = asString(source).trim()
  if (requested === '') throw new Error('source is required (an absolute directory or a git URL)')
  await ensureStore(store)

  let sourceDir
  let cleanup = null
  let origin = requested
  if (isGitSource(requested)) {
    const clone = await cloneToTemp(stripGitPrefix(requested))
    sourceDir = clone.dir
    cleanup = clone.cleanup
  } else {
    const expanded = requested === '~' ? homedir() : requested.startsWith('~/') ? join(homedir(), requested.slice(2)) : requested
    sourceDir = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
    try {
      sourceDir = await realpath(sourceDir)
    } catch {
      throw new Error(`source directory not found: ${requested}`)
    }
    origin = sourceDir
  }

  try {
    if (!(await looksLikeHermesPlugin(sourceDir))) {
      throw new Error(`not a hermes plugin (needs plugin.yaml or desktop/plugin.js): ${requested}`)
    }
    const { fields } = await readManifest(sourceDir)
    const pluginName = asString(name).trim()
      ? safeDirName(name)
      : safeDirName(fields.name) || safeDirName(basename(sourceDir))
    const target = resolveInside(store, pluginName)

    const exists = await isDirectory(target)
    if (exists && !overwrite) {
      throw new Error(`plugin "${pluginName}" is already installed at ${target} (pass overwrite: true to replace it)`)
    }

    const staging = join(store, `.staging-${randomBytes(6).toString('hex')}`)
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    let copy
    try {
      copy = await copyPluginTree(sourceDir, staging)
      if (copy.copied === 0) {
        throw new Error('nothing was copied from the source (all files were excluded or unreadable)')
      }
      if (!(await isFile(join(staging, 'plugin.yaml'))) && !(await isFile(join(staging, 'desktop', 'plugin.js')))) {
        throw new Error('copy produced no plugin.yaml and no desktop/plugin.js; refusing to install')
      }
      if (exists) await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } catch (error) {
      // Never leave a half-written staging directory behind.
      await rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }

    const installedAt = Date.now()
    await updateIndexEntry(store, pluginName, { installedAt, source: origin })
    const dataSources = await readDataSources(store)
    const info = await readPluginInfo(target, { source: origin, installedAt, dataSource: dataSources[pluginName] ?? DEFAULT_SOURCE })
    info.dataSource = dataSources[info.name] ?? dataSources[pluginName] ?? DEFAULT_SOURCE
    return { ...info, copied: copy.copied, skipped: copy.skipped }
  } finally {
    if (cleanup) await cleanup()
  }
}

/**
 * Remove one installed plugin directory.
 * @returns `{ ok: true, name, dir }`
 */
export async function removePlugin(store, name) {
  const wanted = asString(name).trim()
  if (wanted === '') throw new Error('name is required')
  const target = resolveInside(store, safeDirName(wanted))
  const exact = await findPlugin(store, wanted)
  const dir = exact ? exact.dir : target
  if (!(await isDirectory(dir))) throw new Error(`plugin "${wanted}" is not installed`)
  await rm(dir, { recursive: true, force: true })
  await updateIndexEntry(store, safeDirName(wanted), null)
  return { ok: true, name: basename(dir), dir }
}

/* -------------------------------------------------------------------------- */
/* Read paths served to the browser                                           */
/* -------------------------------------------------------------------------- */

/**
 * Read `desktop/plugin.js` for one installed plugin.
 * @returns `{ name, source, bytes }`
 */
export async function readDesktopSource(store, name) {
  const plugin = await findPlugin(store, name)
  if (!plugin) throw new Error(`plugin "${asString(name)}" is not installed`)
  const path = resolveInside(plugin.dir, 'desktop', 'plugin.js')
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch {
    throw new Error(`plugin "${plugin.name}" has no desktop half (desktop/plugin.js)`)
  }
  return { name: plugin.name, source, bytes: Buffer.byteLength(source) }
}

/**
 * Read one of this package's browser modules (`runtime.js`, `sdk.js`, `sdk.css`).
 * @returns `{ text, contentType }`
 */
export async function readBrowserModule(kind) {
  const entry = MODULE_FILES[asString(kind)]
  if (!entry) throw new Error(`unknown module "${asString(kind)}" (expected runtime, sdk or sdk.css)`)
  const path = join(WEB_DIR, entry.file)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    const wrapped = new Error(missing ? `module file is missing: web/${entry.file}` : `module file is unreadable: ${error?.message ?? error}`)
    wrapped.status = missing ? 404 : 500
    throw wrapped
  }
  return { text, contentType: entry.contentType }
}

/** True when this package ships its browser `web/` assets. */
export async function webAssetsReady() {
  try {
    await access(join(WEB_DIR, 'runtime.js'), FS_CONSTANTS.R_OK)
    return true
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Backend lookup                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the backend half of one installed plugin for the sidecar manager.
 * @returns `{ plugin, pluginDir, hasBackend, apiFile, apiPath }`
 */
export async function resolveBackend(store, name) {
  const plugin = await findPlugin(store, name)
  if (!plugin) throw new Error(`plugin "${asString(name)}" is not installed`)
  const backend = await describeBackend(plugin.dir)
  return {
    plugin,
    pluginDir: plugin.dir,
    hasBackend: backend.hasBackend,
    apiFile: backend.backendApi,
    apiPath: backend.apiPath,
    manifest: backend.backendManifest,
  }
}
