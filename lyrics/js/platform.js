// Capability detection, fullscreen and screen wake lock. No side effects on import;
// every function reads globals lazily and never throws.

const nav = () => globalThis.navigator
const doc = () => globalThis.document

// Reads a capability without ever throwing (odd embedders, privacy shims, partial fakes).
function safe(read) {
  try {
    return !!read()
  } catch {
    return false
  }
}

const mediaMatches = (query) => safe(() => globalThis.matchMedia?.(query).matches)

/** True on iPhone/iPad/iPod, including iPadOS that reports itself as a Mac. */
function isIos(n) {
  const ua = String(n?.userAgent ?? '')
  if (/iPhone|iPad|iPod/.test(ua)) return true
  return n?.platform === 'MacIntel' && Number(n?.maxTouchPoints) > 1
}

/**
 * Snapshot of what this browser can do.
 * @returns {{ secure: boolean, serviceWorker: boolean, wakeLock: boolean, fullscreen: boolean, standalone: boolean,
 *   ios: boolean, iosBrowserTab: boolean, persist: boolean, share: boolean, reducedMotion: boolean }}
 */
export function capabilities() {
  const n = nav()
  const d = doc()
  const standalone = mediaMatches('(display-mode: standalone)') || safe(() => n?.standalone === true)
  const ios = safe(() => isIos(n))
  return {
    secure: globalThis.isSecureContext === true,
    serviceWorker: safe(() => n && 'serviceWorker' in n),
    wakeLock: safe(() => n && 'wakeLock' in n),
    fullscreen: safe(() => d?.fullscreenEnabled || d?.webkitFullscreenEnabled),
    standalone,
    ios,
    iosBrowserTab: ios && !standalone,
    persist: safe(() => typeof n?.storage?.persist === 'function'),
    share: safe(() => typeof n?.share === 'function'),
    reducedMotion: mediaMatches('(prefers-reduced-motion: reduce)'),
  }
}

/** The element currently in fullscreen, or null. */
export function fullscreenElement() {
  const d = doc()
  return d?.fullscreenElement ?? d?.webkitFullscreenElement ?? null
}

// Runs a possibly-promise-returning, possibly-throwing API call → Promise<boolean> (true = the call succeeded).
function attempt(call) {
  try {
    return Promise.resolve(call()).then(() => true, () => false)
  } catch {
    return Promise.resolve(false)
  }
}

/**
 * Enters fullscreen on el (default: the root element). Never throws.
 * @returns {Promise<boolean>} false when unsupported or refused
 */
export function requestFullscreen(el = doc()?.documentElement) {
  if (!el) return Promise.resolve(false)
  if (typeof el.requestFullscreen === 'function') return attempt(() => el.requestFullscreen({ navigationUI: 'hide' }))
  if (typeof el.webkitRequestFullscreen === 'function') return attempt(() => el.webkitRequestFullscreen())
  return Promise.resolve(false)
}

/**
 * Leaves fullscreen. Never throws.
 * @returns {Promise<boolean>} false when nothing was fullscreen or the call failed
 */
export function exitFullscreen() {
  const d = doc()
  if (!d || !fullscreenElement()) return Promise.resolve(false)
  if (typeof d.exitFullscreen === 'function') return attempt(() => d.exitFullscreen())
  if (typeof d.webkitExitFullscreen === 'function') return attempt(() => d.webkitExitFullscreen())
  return Promise.resolve(false)
}

/**
 * Calls fn() on every fullscreen change (unprefixed event where supported, else the webkit one).
 * @returns {() => void} unsubscribe
 */
export function onFullscreenChange(fn, { signal } = {}) {
  const d = doc()
  if (!d) return () => {}
  const type = 'onfullscreenchange' in d ? 'fullscreenchange' : 'webkitfullscreenchange'
  const handler = () => fn()
  d.addEventListener(type, handler, { signal })
  return () => d.removeEventListener(type, handler)
}

/**
 * Screen wake lock that re-acquires itself after the system drops it (tab hidden, sentinel released),
 * but only while the signal is live and the page is visible. Released when the signal aborts.
 * request() is cheap to call on every play/cue: it's a no-op while held or while a request is pending.
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {{ readonly state: 'held'|'released'|'denied'|'unsupported', request(): Promise<void>, onchange: ((state: string) => void)|null }}
 */
export function createWakeLock({ signal } = {}) {
  const api = nav()?.wakeLock
  const supported = !!api && typeof api.request === 'function'
  let state = supported ? 'released' : 'unsupported'
  let sentinel = null
  let pending = null
  let wanted = false

  const lock = {
    onchange: null,
    get state() {
      return state
    },
    request,
  }

  const live = () => !signal?.aborted
  const visible = () => doc()?.visibilityState === 'visible'

  function setState(next) {
    if (next === state) return
    state = next
    try {
      lock.onchange?.(state)
    } catch (err) {
      console.error('wake lock onchange failed', err)
    }
  }

  function onRelease() {
    sentinel = null
    if (state === 'held') setState('released')
    // The system drops the lock when the page hides; visibilitychange re-acquires it.
    if (wanted && live() && visible()) request()
  }

  function request() {
    if (!supported || !live()) return Promise.resolve()
    wanted = true
    if (state === 'held' && sentinel && !sentinel.released) return Promise.resolve()
    if (pending) return pending
    if (!visible()) return Promise.resolve()
    pending = acquire().finally(() => {
      pending = null
    })
    return pending
  }

  async function acquire() {
    let s
    try {
      s = await api.request('screen')
    } catch {
      if (live()) setState('denied')
      return
    }
    if (!live()) {
      s.release?.().catch?.(() => {})
      return
    }
    sentinel = s
    s.addEventListener?.('release', onRelease, { once: true })
    setState('held')
  }

  if (supported) {
    doc()?.addEventListener('visibilitychange', () => {
      if (wanted && visible() && state !== 'held') request()
    }, { signal })
    signal?.addEventListener('abort', () => {
      const s = sentinel
      sentinel = null
      if (s) {
        s.removeEventListener?.('release', onRelease)
        Promise.resolve().then(() => s.release()).catch(() => {})
      }
      setState('released')
    }, { once: true })
  }

  return lock
}
