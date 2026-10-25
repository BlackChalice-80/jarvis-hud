// Browser helpers shared by all views: h(), icon(), toasts, sheets, debounce, downloads, dates.
// Nothing here touches the DOM at import time, so Node can import it for the pure helpers.

const SVG_NS = 'http://www.w3.org/2000/svg'
// Assigned after children are appended: a <select>'s value needs its options, a range's value needs min/max.
const LATE_PROPS = new Set(['value', 'checked', 'selectedIndex', 'indeterminate'])

const isNode = (x) => x !== null && typeof x === 'object' && typeof x.nodeType === 'number'

/**
 * Creates an element.
 * props: { class: string|string[]|{name: bool}, style: string|object, dataset, on: { event: fn|[fn, opts] },
 *          attrs: object (setAttribute), ...anything else assigned as a property }.
 * Keys containing '-' (aria-label, data-x) and 'role' are set as attributes. undefined values are skipped.
 * Attribute values: true → '' and false/null → absent, except aria-* booleans → 'true'/'false'.
 * children: strings/numbers (text nodes, never parsed as HTML), Nodes, nested arrays, null/false/undefined (skipped).
 * If props is a string, Node or array it is treated as the first child.
 */
export function h(tag, props = null, ...children) {
  const el = document.createElement(tag)
  if (typeof props === 'string' || typeof props === 'number' || isNode(props) || Array.isArray(props)) {
    children.unshift(props)
    props = null
  }
  const late = []
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined) continue
    if (key === 'class') el.className = classNames(value)
    else if (key === 'style') setStyle(el, value)
    else if (key === 'dataset') setDataset(el, value)
    else if (key === 'on') setListeners(el, value)
    else if (key === 'attrs') setAttrs(el, value)
    else if (key === 'role' || key.includes('-')) setAttrs(el, { [key]: value })
    else if (LATE_PROPS.has(key)) late.push([key, value])
    else el[key] = value
  }
  appendChildren(el, children)
  for (const [key, value] of late) el[key] = value
  return el
}

function classNames(value) {
  if (Array.isArray(value)) return value.flat(Infinity).filter(Boolean).map(String).join(' ')
  if (value && typeof value === 'object') return Object.keys(value).filter((k) => value[k]).join(' ')
  return value == null || value === false ? '' : String(value)
}

function setStyle(el, value) {
  if (typeof value === 'string') {
    el.style.cssText = value
    return
  }
  for (const [k, v] of Object.entries(value ?? {})) {
    if (v == null || v === false) continue
    if (k.includes('-')) el.style.setProperty(k, String(v))
    else el.style[k] = v
  }
}

function setDataset(el, value) {
  for (const [k, v] of Object.entries(value ?? {})) {
    if (v != null) el.dataset[k] = String(v)
  }
}

function setListeners(el, value) {
  for (const [type, handler] of Object.entries(value ?? {})) {
    if (Array.isArray(handler)) el.addEventListener(type, handler[0], handler[1])
    else if (typeof handler === 'function') el.addEventListener(type, handler)
  }
}

// Boolean HTML attributes: true → present, false → absent. ARIA states are enumerated: true/false → 'true'/'false'.
function setAttrs(el, value) {
  for (const [k, v] of Object.entries(value ?? {})) {
    if (typeof v === 'boolean' && k.startsWith('aria-')) el.setAttribute(k, String(v))
    else if (v == null || v === false) continue
    else el.setAttribute(k, v === true ? '' : String(v))
  }
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue
    if (Array.isArray(c)) appendChildren(el, c)
    else if (isNode(c)) el.appendChild(c)
    else el.appendChild(document.createTextNode(String(c)))
  }
}

// ---------------------------------------------------------------------------------------------
// Icons: 24×24 grid, stroked with currentColor at 2px, round caps and joins. [tag, attrs] lists.

const p = (d) => ['path', { d }]
const circle = (cx, cy, r) => ['circle', { cx, cy, r }]
const rect = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }]

const GEAR = 'M10.2 5.3L10.5 2.8L13.5 2.8L13.8 5.3A6.9 6.9 0 0 1 15.5 6L17.5 4.5L19.5 6.5L18 8.5' +
  'A6.9 6.9 0 0 1 18.7 10.2L21.2 10.5L21.2 13.5L18.7 13.8A6.9 6.9 0 0 1 18 15.5L19.5 17.5L17.5 19.5L15.5 18' +
  'A6.9 6.9 0 0 1 13.8 18.7L13.5 21.2L10.5 21.2L10.2 18.7A6.9 6.9 0 0 1 8.5 18L6.5 19.5L4.5 17.5L6 15.5' +
  'A6.9 6.9 0 0 1 5.3 13.8L2.8 13.5L2.8 10.5L5.3 10.2A6.9 6.9 0 0 1 6 8.5L4.5 6.5L6.5 4.5L8.5 6A6.9 6.9 0 0 1 10.2 5.3Z'
const TRAY = 'M4 14.5V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4.5'

const ICONS = {
  play: [p('M7 4.5v15L19.5 12z')],
  pause: [rect(6, 4.5, 4, 15, 1), rect(14, 4.5, 4, 15, 1)],
  prev: [p('M6 5v14'), p('M18.5 5.5L9 12l9.5 6.5z')],
  next: [p('M18 5v14'), p('M5.5 5.5L15 12l-9.5 6.5z')],
  back: [p('M19 12H5'), p('M11 18l-6-6 6-6')],
  gear: [p(GEAR), circle(12, 12, 3)],
  plus: [p('M12 5v14M5 12h14')],
  minus: [p('M5 12h14')],
  more: [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)],
  search: [circle(10.5, 10.5, 6.5), p('M15.5 15.5L20 20')],
  fullscreen: [p('M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4')],
  'fullscreen-exit': [p('M9 4v4a1 1 0 0 1-1 1H4M20 9h-4a1 1 0 0 1-1-1V4M15 20v-4a1 1 0 0 1 1-1h4M4 15h4a1 1 0 0 1 1 1v4')],
  lock: [rect(5, 10.5, 14, 10, 2), p('M8 10.5V8a4 4 0 0 1 8 0v2.5'), p('M12 14.5v2')],
  unlock: [rect(5, 10.5, 14, 10, 2), p('M8 10.5V8a4 4 0 0 1 7.7-1.5'), p('M12 14.5v2')],
  music: [p('M9 18V6l11-2.5V16'), circle(6, 18, 3), circle(17, 16, 3)],
  check: [p('M4.5 12.5l5 5 10-11')],
  x: [p('M6 6l12 12M18 6L6 18')],
  trash: [p('M4 7h16'), p('M9.5 7V4.5h5V7'), p('M6 7l1 12.1a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7'), p('M10 11v5.5M14 11v5.5')],
  edit: [p('M4 20h4.2L19.3 8.9a1.5 1.5 0 0 0 0-2.1l-2.1-2.1a1.5 1.5 0 0 0-2.1 0L4 15.8z'), p('M13.5 6.5l4 4')],
  upload: [p('M12 15V4'), p('M7.5 8.5L12 4l4.5 4.5'), p(TRAY)],
  download: [p('M12 4v11'), p('M7.5 10.5L12 15l4.5-4.5'), p(TRAY)],
  share: [p('M12 3.5V14'), p('M8 7.5l4-4 4 4'), p('M8.5 10.5h-2A1.5 1.5 0 0 0 5 12v7a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-7a1.5 1.5 0 0 0-1.5-1.5h-2')],
  sync: [p('M4 12a8 8 0 0 1 14.4-4.8'), p('M18.5 3v4.5H14'), p('M20 12a8 8 0 0 1-14.4 4.8'), p('M5.5 21v-4.5H10')],
  restart: [p('M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4 9'), p('M4 4.5V9h4.5')],
  list: [p('M9 6h11M9 12h11M9 18h11'), p('M4 6h1M4 12h1M4 18h1')],
}

/** Every icon name icon() knows. */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS))

/**
 * Inline SVG icon (stroke = currentColor). Decorative (aria-hidden) unless a title is given,
 * in which case it gets role="img", aria-label and a <title>. Unknown name → empty svg.
 */
export function icon(name, { size = 24, title } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svgAttrs(svg, {
    class: 'icon icon-' + name,
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  })
  if (title) {
    svgAttrs(svg, { role: 'img', 'aria-label': title })
    const t = document.createElementNS(SVG_NS, 'title')
    t.textContent = title
    svg.appendChild(t)
  } else {
    svg.setAttribute('aria-hidden', 'true')
  }
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const shape = document.createElementNS(SVG_NS, tag)
    svgAttrs(shape, attrs)
    svg.appendChild(shape)
  }
  return svg
}

function svgAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
}

// ---------------------------------------------------------------------------------------------
// Toasts

const TOAST_KINDS = new Set(['info', 'error', 'ok'])
const TOAST_MAX = 3
const LEAVE_MS = 200

/**
 * Binds a toast host to container (index.html has <div id="toast-host">; created on <body> if missing).
 * show() returns { close() }. ms ≤ 0 or non-finite keeps the toast until tapped.
 * @returns {{ el: HTMLElement, show(msg: string, kind?: 'info'|'error'|'ok', ms?: number): { close(): void } }}
 */
export function createToastHost(container) {
  const host = container ?? document.body.appendChild(document.createElement('div'))
  host.classList.add('toast-host')
  host.setAttribute('aria-live', 'polite')
  const closers = new Map()

  function show(msg, kind = 'info', ms = 3500) {
    const k = TOAST_KINDS.has(kind) ? kind : 'info'
    const el = h('div', { class: ['toast', 'toast-' + k] }, String(msg ?? ''))
    let timer = null
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      closers.delete(el)
      el.classList.add('is-leaving')
      setTimeout(() => el.remove(), LEAVE_MS)
    }
    el.addEventListener('click', close)
    host.appendChild(el)
    closers.set(el, close)
    // Keep at most TOAST_MAX on screen: the oldest leave first (Map keeps insertion order).
    for (const [, closeOld] of [...closers].slice(0, Math.max(0, closers.size - TOAST_MAX))) closeOld()
    if (Number.isFinite(ms) && ms > 0) timer = setTimeout(close, ms)
    return { close }
  }

  return { el: host, show }
}

// ---------------------------------------------------------------------------------------------
// Sheets

const openSheets = []
let sheetSeq = 0

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/** True while any sheet (or confirm sheet) is open. main.js can skip view Escape handling then. */
export function sheetOpen() {
  return openSheets.length > 0
}

/**
 * Bottom sheet with a backdrop and a close button. Esc (topmost sheet only), the close button and a backdrop
 * tap close it; so does signal (optional AbortSignal) aborting. onClose(reason) runs once.
 * Focus moves to the first [autofocus] element in content, else the sheet; it is restored on close.
 * @param {{ title?: string|Node, content?: any, onClose?: (reason: string) => void, signal?: AbortSignal }} opts
 * @returns {{ el: HTMLElement, body: HTMLElement, close(reason?: string): void }}
 */
export function openSheet({ title = '', content = null, onClose, signal } = {}) {
  const titleId = 'sheet-title-' + ++sheetSeq
  const ac = new AbortController()
  const previousFocus = document.activeElement
  let closed = false

  const closeBtn = h('button', {
    type: 'button',
    class: 'btn btn-icon btn-ghost sheet-close',
    'aria-label': 'Close',
    on: { click: () => close('close') },
  }, icon('x'))
  const body = h('div', { class: 'sheet-body' }, content)
  const sheet = h('div', {
    class: 'sheet',
    role: 'dialog',
    tabIndex: -1,
    'aria-modal': 'true',
    attrs: title ? { 'aria-labelledby': titleId } : { 'aria-label': 'Dialog' },
  }, h('div', { class: 'sheet-header' }, h('h2', { class: 'sheet-title', id: titleId }, title), closeBtn), body)
  const backdrop = h('div', { class: 'sheet-backdrop' }, sheet)

  const api = { el: sheet, body, close }

  // A tap that starts inside the sheet and ends on the backdrop (text selection, slider drag) must not close it.
  let downOnBackdrop = false
  backdrop.addEventListener('pointerdown', (e) => {
    downOnBackdrop = e.target === backdrop
  }, { signal: ac.signal })
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && downOnBackdrop) close('backdrop')
    downOnBackdrop = false
  }, { signal: ac.signal })
  window.addEventListener('keydown', (e) => {
    if (openSheets.at(-1) !== api) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close('esc')
    } else if (e.key === 'Tab') {
      trapTab(sheet, e)
    }
  }, { capture: true, signal: ac.signal })

  function close(reason = 'api') {
    if (closed) return
    closed = true
    ac.abort()
    const i = openSheets.indexOf(api)
    if (i !== -1) openSheets.splice(i, 1)
    backdrop.classList.add('is-closing')
    setTimeout(() => backdrop.remove(), LEAVE_MS)
    if (previousFocus && previousFocus !== document.body && previousFocus.isConnected && sheet.contains(document.activeElement)) {
      previousFocus.focus?.({ preventScroll: true })
    }
    try {
      onClose?.(reason)
    } catch (err) {
      console.error('sheet onClose failed', err)
    }
  }

  openSheets.push(api)
  document.body.appendChild(backdrop)
  const auto = body.querySelector('[autofocus]')
  ;(auto ?? sheet).focus({ preventScroll: true })
  if (signal?.aborted) close('abort')
  else signal?.addEventListener('abort', () => close('abort'), { once: true, signal: ac.signal })
  return api
}

function trapTab(root, e) {
  const items = [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && el.getClientRects().length)
  if (!items.length) {
    e.preventDefault()
    root.focus()
    return
  }
  const first = items[0]
  const last = items.at(-1)
  const active = document.activeElement
  if (e.shiftKey && (active === first || !root.contains(active) || active === root)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}

/**
 * Confirmation sheet. Resolves true only when the OK button is pressed; Esc, backdrop, close and cancel → false.
 * danger styles OK as destructive and focuses Cancel instead of OK.
 * @returns {Promise<boolean>}
 */
export function confirmSheet(message, { ok = 'OK', cancel = 'Cancel', danger = false, detail, signal } = {}) {
  return new Promise((resolve) => {
    let result = false
    const okBtn = h('button', {
      type: 'button',
      class: ['btn', 'btn-lg', danger ? 'btn-danger' : 'btn-primary'],
      on: { click: () => {
        result = true
        sheet.close('ok')
      } },
    }, ok)
    const cancelBtn = h('button', { type: 'button', class: 'btn btn-lg', on: { click: () => sheet.close('cancel') } }, cancel)
    const content = [
      detail ? h('p', { class: 'sheet-detail' }, detail) : null,
      h('div', { class: 'sheet-actions' }, cancelBtn, okBtn),
    ]
    const sheet = openSheet({ title: message, content, signal, onClose: () => resolve(result) })
    sheet.el.classList.add('sheet-confirm')
    ;(danger ? cancelBtn : okBtn).focus({ preventScroll: true })
  })
}

// ---------------------------------------------------------------------------------------------
// Small utilities

/**
 * Trailing-edge debounce. The wrapper gets .flush() (runs a pending call now and returns its result),
 * .cancel() (drops it) and .pending() (true while a call is scheduled).
 */
export function debounce(fn, ms) {
  let timer = null
  let args = null
  let self

  function run() {
    const a = args
    const s = self
    timer = null
    args = null
    self = undefined
    return fn.apply(s, a)
  }

  function debounced(...callArgs) {
    args = callArgs
    self = this
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(run, ms)
  }

  debounced.flush = () => {
    if (timer === null) return undefined
    clearTimeout(timer)
    return run()
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    args = null
    self = undefined
  }
  debounced.pending = () => timer !== null
  return debounced
}

/** Saves text as a file via a Blob URL and <a download>; the URL is revoked after 60 s. */
export function downloadText(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = h('a', { href: url, download: filename, hidden: true })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

/** ms epoch → localized short date ("Oct 25, 2026" in en-US); 0 / missing → "never". */
export function fmtDate(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return 'never'
  try {
    return new Date(n).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return 'never'
  }
}
