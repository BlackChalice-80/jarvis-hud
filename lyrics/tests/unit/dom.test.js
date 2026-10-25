import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h, icon, ICON_NAMES, debounce, fmtDate } from '../../js/ui/dom.js'

// --- A tiny fake document: just enough DOM for h() and icon() ----------------------------------

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType
    this.childNodes = []
  }
  appendChild(child) {
    this.childNodes.push(child)
    return child
  }
  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(v) {
    this.childNodes = [new FakeText(String(v))]
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3)
    this.data = data
  }
}

class FakeElement extends FakeNode {
  constructor(tag, ns = 'http://www.w3.org/1999/xhtml') {
    super(1)
    this.tagName = tag.toUpperCase()
    this.namespaceURI = ns
    this.attributes = new Map()
    this.listeners = []
    this.dataset = {}
    this.assignLog = []
    const props = new Map()
    this.style = {
      cssText: '',
      setProperty: (k, v) => props.set(k, v),
      getPropertyValue: (k) => props.get(k) ?? '',
    }
    this.className = ''
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v))
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null
  }
  hasAttribute(k) {
    return this.attributes.has(k)
  }
  addEventListener(type, fn, opts) {
    this.listeners.push({ type, fn, opts })
  }
  // Records how many children existed when value/checked were assigned (they must come last).
  set value(v) {
    this.assignLog.push(['value', v, this.childNodes.length])
    this._value = v
  }
  get value() {
    return this._value
  }
  set min(v) {
    this.assignLog.push(['min', v, this.childNodes.length])
  }
  set checked(v) {
    this.assignLog.push(['checked', v, this.childNodes.length])
  }
}

function withFakeDocument(fn) {
  return () => {
    const prev = globalThis.document
    globalThis.document = {
      createElement: (tag) => new FakeElement(tag),
      createElementNS: (ns, tag) => new FakeElement(tag, ns),
      createTextNode: (text) => new FakeText(text),
    }
    try {
      return fn()
    } finally {
      if (prev === undefined) delete globalThis.document
      else globalThis.document = prev
    }
  }
}

// --- h() ----------------------------------------------------------------------------------------

test('h: class as string, array (nested, falsy dropped) and object', withFakeDocument(() => {
  assert.equal(h('div', { class: 'a b' }).className, 'a b')
  assert.equal(h('div', { class: ['btn', null, false, ['btn-primary', [undefined, 'x']]] }).className, 'btn btn-primary x')
  assert.equal(h('div', { class: { on: true, off: false, one: 1, zero: 0 } }).className, 'on one')
  assert.equal(h('div', { class: null }).className, '')
}))

test('h: style string, style object with custom properties and camelCase', withFakeDocument(() => {
  assert.equal(h('div', { style: 'color: red' }).style.cssText, 'color: red')
  const el = h('div', { style: { '--fill': '40%', marginTop: '3px', 'font-size': '12px', color: null, opacity: false } })
  assert.equal(el.style.getPropertyValue('--fill'), '40%')
  assert.equal(el.style.getPropertyValue('font-size'), '12px')
  assert.equal(el.style.marginTop, '3px')
  assert.equal(el.style.color, undefined)
  assert.equal(el.style.opacity, undefined)
}))

test('h: dataset, listeners with options, attrs', withFakeDocument(() => {
  const fn = () => {}
  const el = h('button', {
    dataset: { id: 7, skip: null, name: 'x' },
    on: { click: fn, keydown: [fn, { once: true }], bogus: null },
    attrs: { 'aria-pressed': true, 'aria-expanded': false, hidden: false, title: null, tabindex: 0, inert: true },
  })
  assert.deepEqual(el.dataset, { id: '7', name: 'x' })
  assert.deepEqual(el.listeners.map((l) => [l.type, l.opts]), [['click', undefined], ['keydown', { once: true }]])
  assert.equal(el.getAttribute('aria-pressed'), 'true')
  assert.equal(el.getAttribute('aria-expanded'), 'false')
  assert.equal(el.getAttribute('inert'), '')
  assert.equal(el.getAttribute('tabindex'), '0')
  assert.equal(el.hasAttribute('hidden'), false)
  assert.equal(el.hasAttribute('title'), false)
}))

test('h: dashed keys and role become attributes; other keys are properties; undefined skipped', withFakeDocument(() => {
  const el = h('div', { 'aria-label': 'Close', 'aria-pressed': false, 'data-x': 1, role: 'dialog', tabIndex: -1, hidden: true, title: undefined })
  assert.equal(el.getAttribute('aria-pressed'), 'false')
  assert.equal(el.getAttribute('aria-label'), 'Close')
  assert.equal(el.getAttribute('data-x'), '1')
  assert.equal(el.getAttribute('role'), 'dialog')
  assert.equal(el.tabIndex, -1)
  assert.equal(el.hidden, true)
  assert.equal('title' in el, false)
}))

test('h: children: text never parsed, numbers, nested arrays, null/false/true skipped', withFakeDocument(() => {
  const child = h('b', null, 'bold')
  const el = h('p', null, '<i>not html</i>', 0, null, false, true, undefined, [['a', [child]], 'z'])
  assert.deepEqual(el.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.tagName)), ['<i>not html</i>', '0', 'a', 'B', 'z'])
  assert.equal(el.textContent, '<i>not html</i>0aboldz')
}))

test('h: props given as a child (string, node, array) are treated as children', withFakeDocument(() => {
  assert.equal(h('p', 'hello').textContent, 'hello')
  assert.equal(h('p', h('b', null, 'x'), 'y').textContent, 'xy')
  assert.equal(h('p', ['a', 'b']).textContent, 'ab')
  assert.equal(h('p', 5).textContent, '5')
}))

test('h: value/checked are assigned after other props and after children', withFakeDocument(() => {
  const sel = h('select', { value: 'b', min: 1 }, h('option', null, 'A'), h('option', null, 'B'))
  assert.deepEqual(sel.assignLog, [['min', 1, 0], ['value', 'b', 2]])
  const box = h('input', { checked: true, type: 'checkbox' })
  assert.deepEqual(box.assignLog, [['checked', true, 0]])
  assert.equal(box.type, 'checkbox')
}))

// --- icon() -------------------------------------------------------------------------------------

const SPEC_ICONS = ['play', 'pause', 'prev', 'next', 'back', 'gear', 'plus', 'more', 'search', 'fullscreen', 'fullscreen-exit',
  'lock', 'unlock', 'music', 'check', 'x', 'trash', 'edit', 'upload', 'download', 'share', 'sync', 'minus', 'restart', 'list']

test('icon: every spec name exists and draws shapes on a 24-unit grid with a 2px currentColor stroke', withFakeDocument(() => {
  for (const name of SPEC_ICONS) assert.ok(ICON_NAMES.includes(name), name)
  for (const name of ICON_NAMES) {
    const svg = icon(name)
    assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg')
    assert.equal(svg.tagName, 'SVG')
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24')
    assert.equal(svg.getAttribute('width'), '24')
    assert.equal(svg.getAttribute('stroke'), 'currentColor')
    assert.equal(svg.getAttribute('stroke-width'), '2')
    assert.equal(svg.getAttribute('fill'), 'none')
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    assert.equal(svg.getAttribute('class'), `icon icon-${name}`)
    assert.ok(svg.childNodes.length > 0, name)
    for (const shape of svg.childNodes) {
      assert.equal(shape.namespaceURI, 'http://www.w3.org/2000/svg')
      assert.ok(['PATH', 'CIRCLE', 'RECT'].includes(shape.tagName))
      // All coordinates stay inside the 24×24 box.
      const nums = [...shape.attributes.values()].join(' ').match(/-?\d*\.?\d+/g) ?? []
      if (shape.tagName !== 'PATH') for (const n of nums) assert.ok(Number(n) >= 0 && Number(n) <= 24, `${name}: ${n}`)
    }
  }
}))

test('icon: unknown name → empty svg; size and title options', withFakeDocument(() => {
  const empty = icon('does-not-exist')
  assert.equal(empty.childNodes.length, 0)
  assert.equal(empty.getAttribute('viewBox'), '0 0 24 24')
  const big = icon('play', { size: 40, title: 'Play' })
  assert.equal(big.getAttribute('width'), '40')
  assert.equal(big.getAttribute('height'), '40')
  assert.equal(big.getAttribute('role'), 'img')
  assert.equal(big.getAttribute('aria-label'), 'Play')
  assert.equal(big.hasAttribute('aria-hidden'), false)
  assert.equal(big.childNodes[0].tagName, 'TITLE')
  assert.equal(big.childNodes[0].textContent, 'Play')
}))

// --- debounce -----------------------------------------------------------------------------------

test('debounce: trailing call with the latest args and this; timer restarts on each call', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const obj = {
    n: 1,
    save: debounce(function (a, b) {
      calls.push([this?.n, a, b])
    }, 100),
  }
  obj.save('x', 1)
  t.mock.timers.tick(80)
  obj.save('y', 2)
  t.mock.timers.tick(99)
  assert.deepEqual(calls, [])
  assert.equal(obj.save.pending(), true)
  t.mock.timers.tick(1)
  assert.deepEqual(calls, [[1, 'y', 2]])
  assert.equal(obj.save.pending(), false)
  t.mock.timers.tick(1000)
  assert.equal(calls.length, 1)
})

test('debounce: flush runs the pending call now and returns its result; cancel drops it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let runs = 0
  const d = debounce((x) => {
    runs++
    return x * 2
  }, 500)
  assert.equal(d.flush(), undefined)
  d(21)
  assert.equal(d.flush(), 42)
  assert.equal(runs, 1)
  t.mock.timers.tick(1000)
  assert.equal(runs, 1)
  d(1)
  d.cancel()
  assert.equal(d.pending(), false)
  t.mock.timers.tick(1000)
  assert.equal(runs, 1)
  assert.equal(d.flush(), undefined)
})

test('debounce: an error thrown by fn during flush propagates and leaves nothing pending', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const d = debounce(() => {
    throw new Error('boom')
  }, 10)
  d()
  assert.throws(() => d.flush(), /boom/)
  assert.equal(d.pending(), false)
})

// Deterministic PRNG (mulberry32).
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

test('property: debounce matches a reference model over random call/advance/flush/cancel sequences', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rand = prng(1601)
  for (let run = 0; run < 200; run++) {
    const ms = 1 + Math.floor(rand() * 300)
    const got = []
    const d = debounce((v) => got.push(v), ms)
    // Model: one pending (value, dueAt) slot.
    const want = []
    let now = 0
    let pending = null
    for (let step = 0; step < 40; step++) {
      const r = rand()
      if (r < 0.45) {
        const v = step
        d(v)
        pending = { v, due: now + ms }
      } else if (r < 0.85) {
        const dt = Math.floor(rand() * ms * 1.5)
        if (pending && pending.due <= now + dt) {
          want.push(pending.v)
          pending = null
        }
        now += dt
        t.mock.timers.tick(dt)
      } else if (r < 0.93) {
        d.flush()
        if (pending) want.push(pending.v)
        pending = null
      } else {
        d.cancel()
        pending = null
      }
      assert.equal(d.pending(), pending !== null)
    }
    d.flush()
    if (pending) want.push(pending.v)
    assert.deepEqual(got, want, `run ${run}`)
  }
})

// --- fmtDate ------------------------------------------------------------------------------------

test('fmtDate: 0, negative, NaN and missing → "never"', () => {
  for (const v of [0, -5, NaN, undefined, null, 'abc', Infinity]) assert.equal(fmtDate(v), 'never', String(v))
})

test('fmtDate: localized short date', () => {
  const ms = Date.UTC(2026, 9, 25, 12)
  const s = fmtDate(ms)
  assert.match(s, /2026/)
  assert.match(s, /25/)
  if (new Intl.DateTimeFormat().resolvedOptions().locale === 'en-US') assert.equal(s, 'Oct 25, 2026')
})

test('dom.js does not touch the DOM at import time', async () => {
  assert.equal(globalThis.document, undefined)
  const mod = await import('../../js/ui/dom.js?fresh')
  assert.equal(typeof mod.h, 'function')
})
