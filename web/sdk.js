/**
 * web/sdk.js — browser-side shim of `@hermes/plugin-sdk`.
 *
 * Hermes Desktop plugins are plain ESM files that import a fixed surface from
 * `@hermes/plugin-sdk` (plus `react` / `react/jsx-runtime`). This module
 * re-implements that surface with the React instance the DeepSeek Harness Web
 * UI hands us.
 *
 * IMPORTANT: this file is loaded by the client as a **blob-URL ES module**, so
 * it must not contain a single import statement or bare specifier. Everything
 * it needs arrives through `createSdk({ React, api })`.
 *
 * Grounded surface (every name below actually appears in
 * hermes-desktop-plugin-office-3d/desktop/plugin.js):
 *
 *   ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, PALETTE_AREA, KEYBINDS_AREA,
 *   host, atom, useValue, useQuery, profileColor, cn,
 *   EmptyState, ErrorState, Skeleton, ListRow, ToggleRow, SegmentedControl, Tip
 *
 * `useMutation` is implemented too (working, not a stub) because the wider
 * hermes plugin family is React-Query based; it is NOT grounded in the one
 * plugin source we have.
 *
 * Consumer (web/runtime.js):
 *   const { sdk, AREAS, exportNames } = createSdk({ React, api })
 *   api = {
 *     rest(pluginName, path, init) -> Promise<any>,
 *     storage(pluginName) -> { get(key, dflt), set(key, value), delete(key) },
 *     host: { navigate, notify, notifyError, newChat, openSession, request },
 *   }
 */

// ---------------------------------------------------------------------------
// Area constants
//
// Hermes passes these values straight back into ctx.register({ area }); only
// identity matters, and the runtime compares them against the same constants
// it received from this module.
// ---------------------------------------------------------------------------
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const STATUSBAR_AREAS = Object.freeze({
  left: 'statusbar-left',
  right: 'statusbar-right',
})
export const PALETTE_AREA = 'palette'
export const KEYBINDS_AREA = 'keybinds'

/** Every name the runtime's generated SDK blob module re-exports. */
const EXPORT_NAMES = Object.freeze([
  'ROUTES_AREA',
  'SIDEBAR_NAV_AREA',
  'STATUSBAR_AREAS',
  'PALETTE_AREA',
  'KEYBINDS_AREA',
  'host',
  'atom',
  'useValue',
  'useQuery',
  'useMutation',
  'profileColor',
  'cn',
  'EmptyState',
  'ErrorState',
  'Skeleton',
  'ListRow',
  'ToggleRow',
  'SegmentedControl',
  'Tip',
])

// ---------------------------------------------------------------------------
// Small utilities (no React needed)
// ---------------------------------------------------------------------------

/** Join truthy class strings, clsx style. */
export function cn() {
  const out = []
  const walk = (value) => {
    if (!value) return
    const type = typeof value
    if (type === 'string' || type === 'number') {
      out.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (type === 'object') {
      for (const key in value) if (value[key]) out.push(key)
    }
  }
  for (let i = 0; i < arguments.length; i++) walk(arguments[i])
  return out.join(' ')
}

/** Stable fallback store so useValue() never changes identity mid-render. */
const EMPTY_STORE = {
  get: () => undefined,
  subscribe: () => () => {},
}

function hashString(str) {
  // FNV-1a, 32-bit. Stable across sessions and platforms.
  let h = 2166136261 >>> 0
  const s = String(str == null ? '' : str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360
  const sat = Math.max(0, Math.min(100, s)) / 100
  const light = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) {
    r = c
    g = x
  } else if (hue < 120) {
    r = x
    g = c
  } else if (hue < 180) {
    g = c
    b = x
  } else if (hue < 240) {
    g = x
    b = c
  } else if (hue < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  const toByte = (v) => {
    const n = Math.round((v + m) * 255)
    return Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  }
  return '#' + toByte(r) + toByte(g) + toByte(b)
}

/**
 * Deterministic profile colour.
 *
 * MUST return `#rrggbb` (or `rgb()`): office-3d runs the value through
 * hexToRgb()/shade()/rgba(), which only understand `#hex` and `rgb()/rgba()`.
 * An `hsl()` string would silently disable all shading in the office scene.
 */
export function profileColor(name) {
  const hash = hashString(name)
  const hue = hash % 360
  const sat = 58 + ((hash >>> 9) % 18) // 58–75 %
  const light = 54 + ((hash >>> 17) % 10) // 54–63 %
  return hslToHex(hue, sat, light)
}

// ---------------------------------------------------------------------------
// atom / useValue
// ---------------------------------------------------------------------------

function atom(initialValue) {
  let value = initialValue
  const listeners = new Set()
  const store = {
    get() {
      return value
    },
    set(next) {
      const resolved = typeof next === 'function' ? next(value) : next
      if (Object.is(resolved, value)) return value
      value = resolved
      for (const listener of Array.from(listeners)) {
        try {
          listener(value)
        } catch (err) {
          // A subscriber throwing must not break the producer.
          console.error('[hermes-sdk] atom listener failed:', err)
        }
      }
      return value
    },
    update(fn) {
      return store.set(fn)
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** react-query-ish alias some plugins use. */
    getSnapshot() {
      return value
    },
  }
  return store
}

// ---------------------------------------------------------------------------
// Query cache — a small, dependency-free stand-in for React Query.
// ---------------------------------------------------------------------------

function createQueryCache() {
  const entries = new Map()
  return {
    ensure(key) {
      let entry = entries.get(key)
      if (entry) return entry
      const listeners = new Set()
      entry = {
        key,
        version: 0,
        data: undefined,
        error: null,
        hasData: false,
        status: 'idle', // idle | loading | success | error
        isFetching: false,
        fetchedAt: 0,
        inflight: null,
        observers: 0,
        listeners,
        emit() {
          entry.version += 1
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch (err) {
              console.error('[hermes-sdk] query listener failed:', err)
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        getVersion() {
          return entry.version
        },
      }
      entries.set(key, entry)
      return entry
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    },
  }
}

function startFetch(entry, queryFn) {
  if (entry.inflight) return entry.inflight
  if (typeof queryFn !== 'function') {
    entry.error = new Error('useQuery: queryFn must be a function')
    entry.status = 'error'
    entry.emit()
    return Promise.resolve(undefined)
  }
  if (!entry.hasData) entry.status = 'loading'
  entry.isFetching = true
  entry.emit()

  const run = Promise.resolve()
    .then(() => queryFn())
    .then(
      (data) => {
        entry.data = data
        entry.hasData = true
        entry.error = null
        entry.status = 'success'
      },
      (err) => {
        entry.error = err instanceof Error ? err : new Error(String(err))
        entry.status = 'error'
      },
    )

  entry.inflight = run.then(() => {
    entry.inflight = null
    entry.isFetching = false
    entry.fetchedAt = Date.now()
    entry.emit()
    return entry.data
  })
  return entry.inflight
}

function stableQueryKey(queryKey) {
  if (queryKey === undefined || queryKey === null) return 'null'
  try {
    return JSON.stringify(queryKey)
  } catch (err) {
    return String(queryKey)
  }
}

function positiveInterval(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// ---------------------------------------------------------------------------
// createSdk
// ---------------------------------------------------------------------------

export function createSdk(options) {
  const opts = options || {}
  const React = opts.React
  if (!React || typeof React.createElement !== 'function') {
    throw new Error('createSdk: React is required')
  }
  const R = React
  const el = R.createElement
  const api = opts.api || {}
  const bridge = api.host || {}
  const queryCache = createQueryCache()

  // -- host ---------------------------------------------------------------
  const missingHost = (member) => (...args) => {
    try {
      console.warn('[hermes-sdk] host.' + member + ' is not available in DeepSeek Harness', ...args)
    } catch (err) {
      /* ignore */
    }
    return undefined
  }

  const host = {
    navigate: typeof bridge.navigate === 'function' ? (path, state) => bridge.navigate(path, state) : missingHost('navigate'),
    notify: typeof bridge.notify === 'function' ? (payload) => bridge.notify(payload) : missingHost('notify'),
    notifyError:
      typeof bridge.notifyError === 'function'
        ? (err, message) => bridge.notifyError(err, message)
        : (err, message) => {
            try {
              console.error('[hermes-sdk]', message || 'plugin error', err)
            } catch (e) {
              /* ignore */
            }
          },
    newChat: typeof bridge.newChat === 'function' ? (profile) => bridge.newChat(profile) : missingHost('newChat'),
    openSession:
      typeof bridge.openSession === 'function'
        ? (sessionId, sessionOpts) => bridge.openSession(sessionId, sessionOpts)
        : missingHost('openSession'),
    request:
      typeof bridge.request === 'function'
        ? (method, params) => bridge.request(method, params)
        : missingHost('request'),
  }
  // Forward any extra host members the runtime supplies (no-op today).
  if (bridge && typeof bridge === 'object') {
    for (const key of Object.keys(bridge)) {
      if (!(key in host) && typeof bridge[key] === 'function') host[key] = (...a) => bridge[key](...a)
    }
  }

  // -- hooks --------------------------------------------------------------

  function useValue(store) {
    const target =
      store && typeof store === 'object' && typeof store.get === 'function' && typeof store.subscribe === 'function'
        ? store
        : EMPTY_STORE
    const subscribe = target.subscribe.bind(target)
    const getSnapshot = target.get.bind(target)
    return R.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  function useQuery(queryOptions) {
    const options = queryOptions || {}
    const key = stableQueryKey(options.queryKey)
    const entry = queryCache.ensure(key)
    const optionsRef = R.useRef(options)
    optionsRef.current = options

    // Re-render whenever the shared cache entry changes.
    R.useSyncExternalStore(entry.subscribe, entry.getVersion, entry.getVersion)

    const enabled = options.enabled !== false
    const staleTimeRaw = options.staleTime
    const staleTime = typeof staleTimeRaw === 'number' && staleTimeRaw >= 0 ? staleTimeRaw : 0

    // Mount / unmount bookkeeping (cache survives, like React Query).
    R.useEffect(() => {
      entry.observers += 1
      return () => {
        entry.observers = Math.max(0, entry.observers - 1)
      }
    }, [entry])

    // Fetch on mount / when the key changes / when re-enabled.
    R.useEffect(() => {
      const current = optionsRef.current
      if (current.enabled === false) return
      const stale = !entry.hasData || Date.now() - entry.fetchedAt >= staleTime
      if (stale && !entry.inflight) startFetch(entry, current.queryFn)
    }, [entry, enabled, staleTime])

    // Polling. refetchInterval may be a number OR a function of the query
    // object (office-3d returns `false` when document.hidden), so the function
    // is re-evaluated on every tick instead of captured once.
    R.useEffect(() => {
      const timer = setInterval(() => {
        const current = optionsRef.current
        if (current.enabled === false) return
        const raw = typeof current.refetchInterval === 'function' ? current.refetchInterval(current) : current.refetchInterval
        const interval = positiveInterval(raw)
        if (!interval) return
        if (entry.inflight) return
        if (Date.now() - entry.fetchedAt >= interval) startFetch(entry, current.queryFn)
      }, 250)
      return () => clearInterval(timer)
    }, [entry])

    // Refetch on window focus / tab visibility.
    R.useEffect(() => {
      if (!optionsRef.current.refetchOnWindowFocus) return undefined
      const maybeRefetch = () => {
        const current = optionsRef.current
        if (current.enabled === false) return
        if (typeof document !== 'undefined' && document.hidden) return
        const currentStaleTime = typeof current.staleTime === 'number' ? current.staleTime : 0
        const stale = !entry.hasData || Date.now() - entry.fetchedAt >= currentStaleTime
        if (stale && !entry.inflight) startFetch(entry, current.queryFn)
      }
      const onFocus = () => maybeRefetch()
      const onVisible = () => {
        if (typeof document !== 'undefined' && !document.hidden) maybeRefetch()
      }
      const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
      const hasDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
      if (hasWindow) window.addEventListener('focus', onFocus)
      if (hasDocument) document.addEventListener('visibilitychange', onVisible)
      return () => {
        if (hasWindow) window.removeEventListener('focus', onFocus)
        if (hasDocument) document.removeEventListener('visibilitychange', onVisible)
      }
    }, [entry])

    const refetch = R.useCallback(() => startFetch(entry, optionsRef.current.queryFn), [entry])

    const status =
      entry.status === 'success'
        ? 'success'
        : entry.status === 'error'
          ? 'error'
          : entry.hasData
            ? 'success'
            : 'pending'

    return {
      data: entry.data,
      error: entry.error,
      status,
      isLoading: !entry.hasData && entry.status !== 'error',
      isPending: !entry.hasData,
      isFetching: entry.isFetching,
      isError: entry.status === 'error',
      isSuccess: entry.status === 'success',
      isFetched: entry.hasData,
      isRefetching: entry.isFetching && entry.hasData,
      refetch,
      queryKey: options.queryKey,
    }
  }

  /**
   * Minimal mutation hook. Not grounded in the office-3d source — provided
   * because the wider hermes plugin family is React-Query shaped.
   */
  function useMutation(mutation) {
    const input = typeof mutation === 'function' ? { mutationFn: mutation } : mutation || {}
    const mutationRef = R.useRef(input)
    mutationRef.current = input
    const [state, setState] = R.useState({
      status: 'idle',
      data: undefined,
      error: null,
      variables: undefined,
    })
    const mountedRef = R.useRef(true)
    R.useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
      }
    }, [])

    const mutateAsync = R.useCallback(async (variables) => {
      const current = mutationRef.current
      setState({ status: 'pending', data: undefined, error: null, variables })
      try {
        const data = await current.mutationFn(variables)
        if (mountedRef.current) setState({ status: 'success', data, error: null, variables })
        if (typeof current.onSuccess === 'function') current.onSuccess(data, variables)
        return data
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        if (mountedRef.current) setState({ status: 'error', data: undefined, error, variables })
        if (typeof current.onError === 'function') current.onError(error, variables)
        throw error
      }
    }, [])

    const mutate = R.useCallback(
      (variables) => {
        mutateAsync(variables).catch(() => {})
      },
      [mutateAsync],
    )
    const reset = R.useCallback(() => {
      setState({ status: 'idle', data: undefined, error: null, variables: undefined })
    }, [])

    return {
      ...state,
      isLoading: state.status === 'pending',
      isPending: state.status === 'pending',
      isError: state.status === 'error',
      isSuccess: state.status === 'success',
      mutate,
      mutateAsync,
      reset,
    }
  }

  // -- components ---------------------------------------------------------

  function joinClass(base, extra) {
    return extra ? base + ' ' + extra : base
  }

  /**
   * ListRow — a settings-style row.
   * office-3d: { title, description, action }  (no click handler in this plugin)
   */
  function ListRow(props) {
    const p = props || {}
    const clickable = typeof p.onClick === 'function' && p.disabled !== true
    const right = p.action != null ? el('div', { className: 'hph-listrow-action' }, p.action) : null
    const icon = p.icon != null ? el('span', { className: 'hph-listrow-icon', 'aria-hidden': true }, p.icon) : null
    const text = el(
      'div',
      { className: 'hph-listrow-text' },
      el('div', { className: 'hph-listrow-title' }, p.title),
      p.description != null && p.description !== ''
        ? el('div', { className: 'hph-listrow-desc' }, p.description)
        : null,
    )
    const inner = [icon, text, right]
    const className = joinClass('hph-listrow', cn(clickable && 'hph-listrow-clickable', p.selected && 'hph-listrow-selected', p.disabled && 'hph-listrow-disabled', p.className))
    if (clickable) {
      return el(
        'button',
        { type: 'button', className, onClick: p.onClick, disabled: p.disabled === true, title: p.title ? String(p.title) : undefined },
        inner,
      )
    }
    return el('div', { className }, inner)
  }

  /** ToggleRow — { checked, label, description, onChange, disabled } */
  function ToggleRow(props) {
    const p = props || {}
    const checked = !!p.checked
    const toggle = () => {
      if (p.disabled === true) return
      if (typeof p.onChange === 'function') p.onChange(!checked)
    }
    return el(
      'div',
      { className: joinClass('hph-toggle-row', p.disabled ? 'hph-listrow-disabled' : undefined) },
      el(
        'div',
        { className: 'hph-listrow-text' },
        el('div', { className: 'hph-listrow-title' }, p.label != null ? p.label : p.title),
        p.description != null && p.description !== ''
          ? el('div', { className: 'hph-listrow-desc' }, p.description)
          : null,
      ),
      el(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': p.label != null ? String(p.label) : undefined,
          className: joinClass('hph-switch', checked ? 'hph-switch-on' : undefined),
          onClick: toggle,
          disabled: p.disabled === true,
        },
        el('span', { className: 'hph-switch-thumb' }),
      ),
    )
  }

  /** SegmentedControl — { value, onChange, options: [{ id, label }] } */
  function SegmentedControl(props) {
    const p = props || {}
    const options = Array.isArray(p.options) ? p.options : []
    const current = p.value == null ? undefined : String(p.value)
    const buttons = options.map((option) => {
      const id = option && option.id != null ? String(option.id) : String(option)
      const label = option && option.label != null ? option.label : id
      const active = current === id
      return el(
        'button',
        {
          key: id,
          type: 'button',
          className: joinClass('hph-segment', active ? 'hph-segment-active' : undefined),
          'aria-pressed': active,
          disabled: p.disabled === true,
          onClick: () => {
            if (typeof p.onChange === 'function' && !active) p.onChange(option && option.id != null ? option.id : id)
          },
          title: option && option.title ? String(option.title) : String(label),
        },
        label,
      )
    })
    return el('div', {
      className: joinClass('hph-segmented', p.className),
      role: 'group',
      'data-value': current,
    }, buttons)
  }

  /** Tip — a lightweight host-styled tooltip around arbitrary children. */
  function Tip(props) {
    const p = props || {}
    const label = p.label == null ? '' : String(p.label)
    return el(
      'span',
      {
        className: joinClass('hph-tip', p.className),
        'data-tip': label || undefined,
        title: label || undefined,
      },
      p.children,
    )
  }

  /** EmptyState — { title, description, icon, action } */
  function EmptyState(props) {
    const p = props || {}
    return el(
      'div',
      { className: joinClass('hph-empty', p.className) },
      p.icon != null ? el('div', { className: 'hph-empty-icon', 'aria-hidden': true }, p.icon) : null,
      p.title != null ? el('div', { className: 'hph-empty-title' }, p.title) : null,
      p.description != null && p.description !== ''
        ? el('div', { className: 'hph-empty-desc' }, p.description)
        : null,
      p.action != null ? el('div', { className: 'hph-empty-action' }, p.action) : null,
    )
  }

  /** ErrorState — { title, description, action } */
  function ErrorState(props) {
    const p = props || {}
    return el(
      'div',
      { className: joinClass('hph-state-error', p.className), role: 'alert' },
      el(
        'div',
        { className: 'hph-state-error-head' },
        el('span', { className: 'hph-state-error-dot', 'aria-hidden': true }),
        el('span', { className: 'hph-empty-title' }, p.title != null ? p.title : 'Something went wrong'),
      ),
      p.description != null && p.description !== ''
        ? el('div', { className: 'hph-empty-desc' }, p.description)
        : null,
      p.action != null ? el('div', { className: 'hph-empty-action' }, p.action) : null,
    )
  }

  /** Skeleton — { className, style } */
  function Skeleton(props) {
    const p = props || {}
    return el('div', {
      className: joinClass('hph-skeleton', p.className),
      style: p.style,
      'aria-hidden': true,
    })
  }

  // -- public surface -------------------------------------------------------

  const sdk = {
    ROUTES_AREA,
    SIDEBAR_NAV_AREA,
    STATUSBAR_AREAS,
    PALETTE_AREA,
    KEYBINDS_AREA,
    host,
    atom,
    useValue,
    useQuery,
    useMutation,
    profileColor,
    cn,
    EmptyState,
    ErrorState,
    Skeleton,
    ListRow,
    ToggleRow,
    SegmentedControl,
    Tip,
    // Internal escape hatch used by the runtime; plugins never touch these.
    __internal: { queryCache, api, pluginId: opts.pluginId },
  }

  const AREAS = {
    ROUTES_AREA,
    SIDEBAR_NAV_AREA,
    STATUSBAR_AREAS,
    PALETTE_AREA,
    KEYBINDS_AREA,
  }

  const SdkContext = R.createContext(sdk)

  function SdkProvider(props) {
    const value = props && props.value ? props.value : sdk
    return el(SdkContext.Provider, { value }, (props && props.children) || null)
  }

  function useSdk() {
    const value = R.useContext(SdkContext)
    return value || sdk
  }

  return {
    sdk,
    AREAS,
    exportNames: EXPORT_NAMES.slice(),
    SdkProvider,
    useSdk,
    queryCache,
    cn,
    profileColor,
  }
}

createSdk.exportNames = EXPORT_NAMES.slice()
createSdk.AREAS = {
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA,
  KEYBINDS_AREA,
}
