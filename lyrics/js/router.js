// Hash router: '#/song/abc/perform?x=1' → handler({ path, params, query }).

/**
 * Splits a location hash into a normalized path and a query object.
 * '' | '#' → '/'. Repeated query keys: the last one wins.
 * @param {string} hash
 * @returns {{ path: string, query: Record<string, string> }}
 */
export function parseHash(hash) {
  let s = String(hash ?? '')
  if (s.startsWith('#')) s = s.slice(1)
  const q = s.indexOf('?')
  const rawPath = q === -1 ? s : s.slice(0, q)
  const search = q === -1 ? '' : s.slice(q + 1)
  const segments = splitPath(rawPath)
  const path = '/' + segments.join('/')
  return { path, query: Object.fromEntries(new URLSearchParams(search)) }
}

/**
 * Matches a path against a pattern like '/song/:id/perform'.
 * Empty segments are ignored, so '/add/' and '//add' match '/add'.
 * @returns {Record<string, string> | null} decoded params, or null when it doesn't match
 */
export function matchPattern(pattern, path) {
  const want = splitPath(pattern)
  const got = splitPath(path)
  if (want.length !== got.length) return null
  const params = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(':')) params[want[i].slice(1)] = decode(got[i])
    else if (want[i] !== got[i]) return null
  }
  return params
}

/**
 * @param {Array<[string, (route: object) => any]>} routes first match wins
 * @param {{ onNotFound?: (route: object) => any, win?: Window }} [opts]
 *   win defaults to globalThis.window; tests pass a fake with location + add/removeEventListener.
 */
export function createRouter(routes, { onNotFound, win = globalThis.window } = {}) {
  let current = null

  function dispatch() {
    const { path, query } = parseHash(win.location.hash)
    let handler = onNotFound
    let params = {}
    for (const [pattern, fn] of routes) {
      const m = matchPattern(pattern, path)
      if (m) {
        handler = fn
        params = m
        break
      }
    }
    current = { path, params, query }
    run(handler, current)
  }

  const onHashChange = () => dispatch()

  return {
    /** Dispatches the current hash (empty → '#/') and starts listening to hashchange. */
    start() {
      win.removeEventListener('hashchange', onHashChange)
      win.addEventListener('hashchange', onHashChange)
      dispatch()
    },
    /** Stops listening to hashchange. */
    stop() {
      win.removeEventListener('hashchange', onHashChange)
    },
    /**
     * Navigates to path ('/add' or '#/add'). replace → location.replace (no history entry).
     * Going to the hash that is already current fires no hashchange, so it re-dispatches directly.
     */
    go(path, { replace = false } = {}) {
      const hash = toHash(path)
      if (sameHash(win.location.hash, hash)) {
        dispatch()
        return
      }
      if (replace) win.location.replace(withHash(win.location.href, hash))
      else win.location.hash = hash
    },
    /** The last dispatched route object, or null before start(). */
    get current() {
      return current
    },
  }
}

function run(handler, route) {
  if (typeof handler !== 'function') return
  try {
    const r = handler(route)
    if (r && typeof r.catch === 'function') r.catch((err) => console.error('route handler failed', err))
  } catch (err) {
    console.error('route handler failed', err)
  }
}

function splitPath(path) {
  return String(path ?? '').split('/').filter(Boolean)
}

function decode(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function toHash(path) {
  const s = String(path ?? '')
  if (s.startsWith('#')) return s
  return '#' + (s.startsWith('/') ? s : '/' + s)
}

function sameHash(a, b) {
  const norm = (h) => (h === '' || h === '#' ? '#/' : h)
  return norm(String(a ?? '')) === norm(b)
}

function withHash(href, hash) {
  const s = String(href ?? '')
  const i = s.indexOf('#')
  return (i === -1 ? s : s.slice(0, i)) + hash
}
