import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouter, parseHash, matchPattern } from '../../js/router.js'

// Minimal stand-in for window: location.hash / location.replace fire 'hashchange' asynchronously, like browsers do.
function fakeWin(initialHash = '') {
  const listeners = new Set()
  let hash = initialHash
  const base = 'https://example.test/jarvis-hud/lyrics/'
  const log = []
  const fire = () => queueMicrotask(() => listeners.forEach((fn) => fn({ type: 'hashchange' })))
  const setHash = (next, how) => {
    const h = next === '' || next === '#' ? '' : next.startsWith('#') ? next : '#' + next
    log.push([how, h])
    if (h === hash) return
    hash = h
    fire()
  }
  const location = {
    get hash() {
      return hash
    },
    set hash(v) {
      setHash(String(v), 'assign')
    },
    get href() {
      return base + hash
    },
    replace(url) {
      const i = url.indexOf('#')
      setHash(i === -1 ? '' : url.slice(i), 'replace')
    },
  }
  return {
    location,
    log,
    addEventListener(type, fn) {
      if (type === 'hashchange') listeners.add(fn)
    },
    removeEventListener(type, fn) {
      if (type === 'hashchange') listeners.delete(fn)
    },
    get listenerCount() {
      return listeners.size
    },
    // Simulates the user editing the URL bar / pressing back.
    userNavigate(h) {
      setHash(h, 'user')
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function makeApp(initialHash = '') {
  const win = fakeWin(initialHash)
  const calls = []
  const rec = (name) => (route) => calls.push([name, route])
  const router = createRouter(
    [
      ['/', rec('library')],
      ['/add', rec('add')],
      ['/song/:id/perform', rec('perform')],
      ['/song/:id/edit', rec('edit')],
      ['/song/:id/sync', rec('sync')],
      ['/settings', rec('settings')],
      ['/demo', rec('demo')],
    ],
    { onNotFound: rec('notfound'), win },
  )
  return { win, calls, router }
}

test('parseHash: empty and bare hashes map to /', () => {
  assert.deepEqual(parseHash(''), { path: '/', query: {} })
  assert.deepEqual(parseHash('#'), { path: '/', query: {} })
  assert.deepEqual(parseHash('#/'), { path: '/', query: {} })
  assert.deepEqual(parseHash(undefined), { path: '/', query: {} })
})

test('parseHash: path and query', () => {
  assert.deepEqual(parseHash('#/song/abc/perform?x=1'), { path: '/song/abc/perform', query: { x: '1' } })
  assert.deepEqual(parseHash('#/?debug'), { path: '/', query: { debug: '' } })
  assert.deepEqual(parseHash('#/add?q=a+b&q=last&e=%26'), { path: '/add', query: { q: 'last', e: '&' } })
  assert.deepEqual(parseHash('#add/'), { path: '/add', query: {} })
  assert.deepEqual(parseHash('#//add//'), { path: '/add', query: {} })
})

test('matchPattern: literals, params, length mismatch', () => {
  assert.deepEqual(matchPattern('/', '/'), {})
  assert.deepEqual(matchPattern('/add', '/add/'), {})
  assert.equal(matchPattern('/add', '/settings'), null)
  assert.deepEqual(matchPattern('/song/:id/perform', '/song/abc/perform'), { id: 'abc' })
  assert.equal(matchPattern('/song/:id/perform', '/song/abc'), null)
  assert.equal(matchPattern('/song/:id/perform', '/song/abc/perform/extra'), null)
  assert.equal(matchPattern('/song/:id/perform', '/song/abc/edit'), null)
  assert.deepEqual(matchPattern('/a/:x/:y', '/a/1/2'), { x: '1', y: '2' })
})

test('matchPattern: params are decodeURIComponent-ed; malformed escapes stay raw', () => {
  assert.deepEqual(matchPattern('/song/:id/edit', '/song/a%20b%2Fc/edit'), { id: 'a b/c' })
  assert.deepEqual(matchPattern('/song/:id/edit', '/song/caf%C3%A9/edit'), { id: 'café' })
  assert.deepEqual(matchPattern('/song/:id/edit', '/song/%E0%A4%A/edit'), { id: '%E0%A4%A' })
})

test('start() with an empty hash dispatches the library route', () => {
  const { calls, router } = makeApp('')
  router.start()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'library')
  assert.deepEqual(calls[0][1], { path: '/', params: {}, query: {} })
  assert.deepEqual(router.current, { path: '/', params: {}, query: {} })
})

test('start() dispatches the current hash with params and query', () => {
  const { calls, router } = makeApp('#/song/abc/perform?x=1')
  assert.equal(router.current, null)
  router.start()
  assert.deepEqual(calls, [['perform', { path: '/song/abc/perform', params: { id: 'abc' }, query: { x: '1' } }]])
  assert.equal(router.current, calls[0][1])
})

test('unknown routes call onNotFound and still update current', () => {
  const { calls, router } = makeApp('#/nope/really?z=2')
  router.start()
  assert.deepEqual(calls, [['notfound', { path: '/nope/really', params: {}, query: { z: '2' } }]])
  assert.deepEqual(router.current, { path: '/nope/really', params: {}, query: { z: '2' } })
})

test('missing onNotFound is fine', () => {
  const win = fakeWin('#/nowhere')
  const router = createRouter([['/', () => {}]], { win })
  assert.doesNotThrow(() => router.start())
  assert.equal(router.current.path, '/nowhere')
})

test('first matching route wins', () => {
  const win = fakeWin('#/song/new/edit')
  const hits = []
  const router = createRouter(
    [
      ['/song/new/edit', () => hits.push('literal')],
      ['/song/:id/edit', () => hits.push('param')],
    ],
    { win },
  )
  router.start()
  assert.deepEqual(hits, ['literal'])
})

test('hashchange dispatches (user navigation, back button)', async () => {
  const { win, calls, router } = makeApp('#/')
  router.start()
  win.userNavigate('#/settings')
  await tick()
  win.userNavigate('')
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['library', 'settings', 'library'])
})

test('go(path) assigns location.hash and dispatches once via hashchange', async () => {
  const { win, calls, router } = makeApp('#/')
  router.start()
  router.go('/add')
  assert.equal(win.location.hash, '#/add')
  assert.deepEqual(win.log.at(-1), ['assign', '#/add'])
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['library', 'add'])
  router.go('#/settings')
  await tick()
  assert.equal(win.location.hash, '#/settings')
  router.go('song/x/sync')
  await tick()
  assert.equal(win.location.hash, '#/song/x/sync')
  assert.deepEqual(calls.map((c) => c[0]), ['library', 'add', 'settings', 'sync'])
})

test('go(path, { replace: true }) uses location.replace', async () => {
  const { win, calls, router } = makeApp('#/demo')
  router.start()
  router.go('/song/demo-soundcheck/perform', { replace: true })
  assert.deepEqual(win.log.at(-1), ['replace', '#/song/demo-soundcheck/perform'])
  assert.ok(!win.log.some(([how]) => how === 'assign'))
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['demo', 'perform'])
  assert.deepEqual(router.current.params, { id: 'demo-soundcheck' })
})

test('go() to the current hash re-dispatches exactly once', async () => {
  const { calls, router } = makeApp('#/settings')
  router.start()
  router.go('/settings')
  await tick()
  router.go('/settings', { replace: true })
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['settings', 'settings', 'settings'])
})

test('go("/") from an empty hash re-dispatches the library', async () => {
  const { calls, router } = makeApp('')
  router.start()
  router.go('/')
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['library', 'library'])
})

test('start() twice does not double-subscribe; stop() unsubscribes', async () => {
  const { win, calls, router } = makeApp('#/')
  router.start()
  router.start()
  assert.equal(win.listenerCount, 1)
  win.userNavigate('#/add')
  await tick()
  assert.deepEqual(calls.map((c) => c[0]), ['library', 'library', 'add'])
  router.stop()
  assert.equal(win.listenerCount, 0)
  win.userNavigate('#/settings')
  await tick()
  assert.equal(calls.length, 3)
})

test('a throwing or rejecting handler does not break the router', async (t) => {
  const errors = []
  t.mock.method(console, 'error', (...args) => errors.push(args))
  const win = fakeWin('#/')
  const seen = []
  const router = createRouter(
    [
      ['/', () => {
        throw new Error('boom')
      }],
      ['/a', () => Promise.reject(new Error('async boom'))],
      ['/b', (r) => seen.push(r.path)],
    ],
    { win },
  )
  router.start()
  win.userNavigate('#/a')
  await tick()
  win.userNavigate('#/b')
  await tick()
  assert.deepEqual(seen, ['/b'])
  assert.equal(errors.length, 2)
})

// Deterministic PRNG (mulberry32) for property tests.
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = 'abcXYZ019-_.~ /?#&=%+:é漢🎤'

function randomString(rand, min = 1, max = 12) {
  const chars = [...ALPHABET]
  const n = min + Math.floor(rand() * (max - min + 1))
  let s = ''
  for (let i = 0; i < n; i++) s += chars[Math.floor(rand() * chars.length)]
  return s
}

test('property: params round-trip through encodeURIComponent for random patterns', () => {
  const rand = prng(20261025)
  for (let iter = 0; iter < 500; iter++) {
    const nSeg = 1 + Math.floor(rand() * 5)
    const pattern = []
    const path = []
    const want = {}
    for (let i = 0; i < nSeg; i++) {
      if (rand() < 0.5) {
        const name = 'p' + i
        const value = randomString(rand)
        pattern.push(':' + name)
        path.push(encodeURIComponent(value))
        want[name] = value
      } else {
        const lit = 'seg' + Math.floor(rand() * 100)
        pattern.push(lit)
        path.push(lit)
      }
    }
    const pat = '/' + pattern.join('/')
    const p = '/' + path.join('/')
    assert.deepEqual(matchPattern(pat, p), want, `${pat} vs ${p}`)
    // parseHash keeps the encoded path intact (including encoded '?', '#', '/').
    assert.equal(parseHash('#' + p + '?k=v').path, p)
  }
})

test('property: query values round-trip through URLSearchParams encoding', () => {
  const rand = prng(7)
  for (let iter = 0; iter < 300; iter++) {
    const want = {}
    const n = Math.floor(rand() * 4)
    for (let i = 0; i < n; i++) want['k' + i] = randomString(rand, 0, 10)
    const qs = new URLSearchParams(want).toString()
    const { path, query } = parseHash('#/song/x/perform' + (qs ? '?' + qs : ''))
    assert.equal(path, '/song/x/perform')
    assert.deepEqual(query, want)
  }
})

test('property: random hashes always yield a normalized path and never throw', () => {
  const rand = prng(99)
  for (let iter = 0; iter < 500; iter++) {
    const h = '#' + randomString(rand, 0, 20)
    const { path, query } = parseHash(h)
    assert.ok(path.startsWith('/'))
    assert.ok(!path.includes('//'))
    assert.ok(path === '/' || !path.endsWith('/'))
    assert.equal(typeof query, 'object')
  }
})
