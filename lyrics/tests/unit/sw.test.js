import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
import { ROOT, listAssets, computeVersion, parseSw, renderSw } from '../../tools/stamp-sw.mjs'

const swSource = await readFile(join(ROOT, 'sw.js'), 'utf8')
const { version: VERSION, assets: ASSETS } = parseSw(swSource)

// --- Static checks: sw.js is stamped from the current shipped file set ------------------------

test('ASSETS lists exactly the shipped runtime files (run `npm run sw:stamp` if this fails)', async () => {
  const files = await listAssets()
  assert.deepEqual(ASSETS, ['./', ...files])
})

test('VERSION is the stamp hash of the shipped files (run `npm run sw:stamp` if this fails)', async () => {
  assert.match(VERSION, /^[0-9a-f]{8}$/)
  assert.equal(VERSION, await computeVersion(ASSETS.slice(1)))
})

test('ASSETS: relative, unique, existing files, nothing from tests/tools/docs', async () => {
  assert.equal(ASSETS[0], './')
  assert.equal(new Set(ASSETS).size, ASSETS.length)
  for (const a of ASSETS.slice(1)) {
    assert.ok(!a.startsWith('/') && !a.startsWith('.') && !/^[a-z]+:/i.test(a), `not relative: ${a}`)
    assert.ok(!/^(tests|tools|docs|node_modules)\//.test(a), `not shipped: ${a}`)
    assert.ok(!['package.json', 'sw.js', 'README.md'].includes(a), `not shipped: ${a}`)
    assert.ok(/^(index\.html|manifest\.webmanifest|css\/[^/]+\.css|js\/.+\.js|icons\/[^/]+)$/.test(a), `unexpected: ${a}`)
    assert.ok((await stat(join(ROOT, a))).isFile(), `missing: ${a}`)
  }
  for (const required of ['index.html', 'manifest.webmanifest', 'css/app.css', 'js/router.js', 'js/platform.js',
    'js/ui/dom.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']) {
    assert.ok(ASSETS.includes(required), `ASSETS lacks ${required}`)
  }
})

test('local files referenced by index.html and the manifest are precached', async (t) => {
  const html = await readFile(join(ROOT, 'index.html'), 'utf8')
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'))
  const refs = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1])
  refs.push(...manifest.icons.map((i) => i.src))
  for (const r of refs) assert.ok(!r.startsWith('/') && !/^[a-z]+:/i.test(r), `index.html/manifest URL must be relative: ${r}`)
  const missing = []
  for (const r of refs) {
    const exists = await stat(join(ROOT, r)).then((s) => s.isFile(), () => false)
    if (!exists) missing.push(r)
    else assert.ok(ASSETS.includes(r), `${r} is referenced but not in ASSETS`)
  }
  // css/perform.css, css/views.css and js/main.js are written by other modules; until they exist this is a todo.
  if (missing.length) t.todo(`referenced but not on disk yet: ${missing.join(', ')}`)
})

test('renderSw/parseSw round-trip and only touch the two generated lines', () => {
  const src = "// head\nconst VERSION = 'abc'\nconst ASSETS = [\n  './',\n]\n\nconst KEEP = ['x']\n"
  const out = renderSw(src, '0123abcd', ['index.html', 'js/a b.js'])
  assert.deepEqual(parseSw(out), { version: '0123abcd', assets: ['./', 'index.html', 'js/a b.js'] })
  assert.ok(out.startsWith('// head\n'))
  assert.ok(out.endsWith("\n\nconst KEEP = ['x']\n"))
  assert.equal(renderSw(out, '0123abcd', ['index.html', 'js/a b.js']), out)
  assert.throws(() => renderSw('nothing here', 'x', []))
})

test('manifest fields match the spec', async () => {
  const m = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'))
  assert.equal(m.name, 'StageLyrics')
  assert.equal(m.short_name, 'StageLyrics')
  assert.equal(m.start_url, './')
  assert.equal(m.scope, './')
  assert.equal(m.id, './')
  assert.equal(m.display, 'standalone')
  assert.deepEqual(m.display_override, ['fullscreen', 'standalone'])
  assert.equal(m.background_color, '#000')
  assert.equal(m.theme_color, '#000')
  assert.equal(m.orientation, 'any')
  const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`)
  assert.deepEqual(sizes, ['192x192:any', '512x512:any', '512x512:maskable'])
})

// --- Behaviour: run sw.js in a sandbox with fake caches/fetch/clients ------------------------

const SCOPE = 'https://stage.test/jarvis-hud/lyrics/'
const keyOf = (req, ignoreSearch) => {
  const u = new URL(typeof req === 'string' ? req : req.url)
  if (ignoreSearch) u.search = ''
  u.hash = ''
  return u.href
}

class FakeCache {
  constructor(fetchFn) {
    this.entries = new Map()
    this.fetchFn = fetchFn
    this.added = []
  }
  async addAll(requests) {
    for (const r of requests) {
      this.added.push(r)
      this.entries.set(keyOf(r), await this.fetchFn(r))
    }
  }
  async put(req, res) {
    this.entries.set(keyOf(req), res)
  }
  async match(req, { ignoreSearch = false } = {}) {
    const want = keyOf(req, ignoreSearch)
    for (const [k, v] of this.entries) if (keyOf(k, ignoreSearch) === want) return v
    return undefined
  }
}

function sandbox() {
  const listeners = {}
  const network = []
  const fetchFn = async (req) => {
    network.push(req)
    return new Response('net:' + keyOf(req), { status: 200 })
  }
  const store = new Map()
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache(fetchFn))
      return store.get(name)
    },
    async keys() {
      return [...store.keys()]
    },
    async delete(name) {
      return store.delete(name)
    },
    async match() {
      throw new Error('sw.js must read its own versioned cache, not caches.match()')
    },
  }
  const calls = { skipWaiting: 0, claim: 0 }
  const self = {
    registration: { scope: SCOPE },
    addEventListener(type, fn) {
      listeners[type] = fn
    },
    skipWaiting() {
      calls.skipWaiting++
      return Promise.resolve()
    },
    clients: {
      claim() {
        calls.claim++
        return Promise.resolve()
      },
    },
  }
  vm.runInNewContext(swSource, { self, caches, fetch: fetchFn, Request, Response, URL, console }, { filename: 'sw.js' })

  async function lifecycle(type, extra = {}) {
    const waits = []
    listeners[type]({ waitUntil: (p) => waits.push(p), ...extra })
    await Promise.all(waits)
    return waits.length
  }
  async function fetchEvent(url, { method = 'GET', mode = 'no-cors' } = {}) {
    let responded = null
    listeners.fetch({ request: { url, method, mode }, respondWith: (p) => (responded = Promise.resolve(p)) })
    return responded === null ? null : await responded
  }
  return { listeners, network, store, calls, caches, lifecycle, fetchEvent, current: 'stagelyrics-' + VERSION }
}

test('install precaches every ASSET, resolved against the scope with cache: reload, without skipWaiting', async () => {
  const sw = sandbox()
  assert.equal(await sw.lifecycle('install'), 1)
  const cache = sw.store.get(sw.current)
  assert.ok(cache, 'opens stagelyrics-' + VERSION)
  assert.deepEqual(cache.added.map((r) => r.url), ASSETS.map((a) => new URL(a, SCOPE).href))
  assert.ok(cache.added.every((r) => r.cache === 'reload'))
  assert.equal(sw.calls.skipWaiting, 0)
  assert.equal(sw.calls.claim, 0)
})

test('activate deletes only older stagelyrics-* caches, then claims clients', async () => {
  const sw = sandbox()
  for (const name of ['stagelyrics-deadbeef', 'stagelyrics-', sw.current, 'other-app-v1']) await sw.caches.open(name)
  await sw.lifecycle('activate')
  assert.deepEqual([...sw.store.keys()].sort(), [sw.current, 'other-app-v1'].sort())
  assert.equal(sw.calls.claim, 1)
})

test('fetch ignores non-GET, cross-origin (LRCLIB) and out-of-scope requests', async () => {
  const sw = sandbox()
  await sw.lifecycle('install')
  assert.equal(await sw.fetchEvent(SCOPE + 'js/router.js', { method: 'POST' }), null)
  assert.equal(await sw.fetchEvent('https://lrclib.net/api/search?track_name=x'), null)
  assert.equal(await sw.fetchEvent('https://stage.test/jarvis-hud/other.js'), null)
  assert.equal(await sw.fetchEvent('https://stage.test/jarvis-hud/lyrics-old/index.html'), null)
  assert.equal(await sw.fetchEvent('https://stage.test/jarvis-hud/lyrics/', { method: 'HEAD', mode: 'navigate' }), null)
})

test('navigations get the cached index.html (any path or query), network only as a fallback', async () => {
  const sw = sandbox()
  await sw.lifecycle('install')
  const before = sw.network.length
  for (const url of [SCOPE, SCOPE + '?debug', SCOPE + 'index.html#/song/x/perform', SCOPE + 'settings']) {
    const res = await sw.fetchEvent(url, { mode: 'navigate' })
    assert.equal(await res.clone().text(), 'net:' + SCOPE + 'index.html', url)
  }
  assert.equal(sw.network.length, before, 'no network for cached navigations')

  const cold = sandbox()
  const res = await cold.fetchEvent(SCOPE + '?nosw', { mode: 'navigate' })
  assert.equal(await res.text(), 'net:' + SCOPE + '?nosw')
})

test('in-scope assets are cache-first with ignoreSearch, network as a fallback', async () => {
  const sw = sandbox()
  await sw.lifecycle('install')
  const before = sw.network.length
  const hit = await sw.fetchEvent(SCOPE + 'js/router.js?v=123')
  assert.equal(await hit.text(), 'net:' + SCOPE + 'js/router.js')
  assert.equal(sw.network.length, before)
  const miss = await sw.fetchEvent(SCOPE + 'js/not-precached.js?x=1')
  assert.equal(await miss.text(), 'net:' + SCOPE + 'js/not-precached.js?x=1')
  assert.equal(sw.network.length, before + 1)
})

test("fetch reads only this version's cache (a waiting worker's files never leak in)", async () => {
  const sw = sandbox()
  const newer = await sw.caches.open('stagelyrics-ffffffff')
  await newer.put(SCOPE + 'js/router.js', new Response('newer'))
  const res = await sw.fetchEvent(SCOPE + 'js/router.js')
  assert.equal(await res.text(), 'net:' + SCOPE + 'js/router.js')
})

test('message SKIP_WAITING calls skipWaiting; anything else is ignored', () => {
  const sw = sandbox()
  sw.listeners.message({ data: null })
  sw.listeners.message({ data: 'SKIP_WAITING' })
  sw.listeners.message({ data: { type: 'OTHER' } })
  assert.equal(sw.calls.skipWaiting, 0)
  sw.listeners.message({ data: { type: 'SKIP_WAITING' } })
  assert.equal(sw.calls.skipWaiting, 1)
})
