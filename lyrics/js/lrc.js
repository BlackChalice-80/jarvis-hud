// LRC and plain-lyrics parsing, LRC serialization, and section headers.

import { formatTime, parseTime } from './format.js'
import { applyMarkerInvariants } from './timing.js'

/** One LRC time tag at the start of a string. A third field is always a fraction, never hours. */
export const TIME_TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/

/** Words recognized as section headers ("[Chorus]", "Verse 2:", "Bridge"). */
export const SECTION_WORDS = Object.freeze(['intro', 'verse', 'pre-chorus', 'prechorus', 'chorus', 'post-chorus', 'hook',
  'refrain', 'bridge', 'breakdown', 'interlude', 'instrumental', 'solo', 'outro', 'tag', 'coda'])

const META_LINE = /^\[(ti|ar|al|au|by|length|offset|re|ve|#):(.*)\]$/i
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g
const OFFSET_VALUE = /^\s*([+-]?)\s*(\d+(?:\.\d*)?|\.\d+)\s*$/

const WORDS_RE = [...SECTION_WORDS].sort((a, b) => b.length - a.length).join('|')
const LABEL = `(${WORDS_RE})(?:\\s*(\\d+))?`
const HEADER_FORMS = [
  new RegExp(`^\\[\\s*${LABEL}\\s*(?::.*)?\\]$`, 'i'),
  new RegExp(`^\\(\\s*${LABEL}\\s*(?::.*)?\\)$`, 'i'),
  new RegExp(`^\\{\\s*${LABEL}\\s*(?::.*)?\\}$`, 'i'),
  new RegExp(`^${LABEL}\\s*:$`, 'i'),
  new RegExp(`^${LABEL}$`, 'i'),
]

const titleCase = (word) => word.toLowerCase().split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('-')

/**
 * Recognizes a section header line: "[Chorus]", "(Verse 2)", "{Bridge}", "[Chorus: Name]", "Chorus:",
 * or a bare "Verse 2" (case-insensitive, whole trimmed line).
 * @param {string} line
 * @returns {string|null} title-cased label such as "Chorus", "Verse 2", "Pre-Chorus"
 */
export function parseSectionHeader(line) {
  if (typeof line !== 'string') return null
  const s = line.trim()
  for (const re of HEADER_FORMS) {
    const m = re.exec(s)
    if (m) return titleCase(m[1]) + (m[2] !== undefined ? ' ' + Number(m[2]) : '')
  }
  return null
}

function splitLines(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
}

/** Parses one time tag at the start of s → { t, len } or null (seconds must be 0..59). */
function readTimeTag(s) {
  const m = TIME_TAG.exec(s)
  if (!m) return null
  const sec = Number(m[2])
  if (sec > 59) return null
  return { t: Number(m[1]) * 60 + sec + (m[3] ? Number('0.' + m[3]) : 0), len: m[0].length }
}

/** Consumes the leading run of time tags (whitespace allowed between) → { times, rest }. */
function readTagRun(line) {
  const times = []
  let rest = line.replace(/^\s+/, '')
  for (let tag = readTimeTag(rest); tag; tag = readTimeTag(rest)) {
    times.push(tag.t)
    rest = rest.slice(tag.len).replace(/^\s+/, '')
  }
  return { times, rest }
}

const cleanText = (s) => s.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim()

/**
 * True when the text looks like LRC: at least one timed line, and timed lines make up at least
 * half of the non-blank, non-metadata lines.
 * @param {string} text
 * @returns {boolean}
 */
export function isLrc(text) {
  let timed = 0
  let content = 0
  for (const raw of splitLines(text)) {
    const s = raw.trim()
    if (s === '' || META_LINE.test(s)) continue
    content++
    if (readTimeTag(s)) timed++
  }
  return timed >= 1 && timed >= content * 0.5
}

function parseOffsetMs(value) {
  const m = OFFSET_VALUE.exec(value)
  if (!m) return null
  const n = Number(m[2])
  if (!Number.isFinite(n)) return null
  return m[1] === '-' ? -n : n
}

function readMeta(meta, key, value) {
  const k = key.toLowerCase()
  if (k === 'ti' || k === 'ar' || k === 'al') {
    const v = value.trim()
    if (v) meta[k] = v
  } else if (k === 'length') {
    const len = parseTime(value)
    if (len !== null) meta.length = len
  } else if (k === 'offset') {
    const ms = parseOffsetMs(value)
    if (ms !== null) meta.offsetMs = ms
  }
}

/** Times for a run of m untimed lines after a timed line at ta (null = no later timed line yet). */
function interpolate(ta, tb, m) {
  const out = []
  for (let k = 1; k <= m; k++) {
    if (tb === null) out.push(ta + 2 * k)
    else if (tb < ta) out.push(ta)
    else out.push(ta + ((tb - ta) * k) / (m + 1))
  }
  return out
}

/** Stable-sorts by t, then removes exact (t, text) duplicates and applies the marker invariants. */
function finishLines(entries) {
  entries.sort((a, b) => a.t - b.t)
  const seen = new Map()
  const unique = []
  for (const l of entries) {
    let texts = seen.get(l.t)
    if (!texts) seen.set(l.t, (texts = new Set()))
    if (texts.has(l.text)) continue
    texts.add(l.text)
    unique.push(l)
  }
  return applyMarkerInvariants(unique)
}

/**
 * Parses LRC text. The [offset:] tag is baked into t (positive = earlier) and must not be applied
 * again; meta.offsetMs is informational. Untimed lines are counted and dropped, or with keepUntimed
 * interpolated between their timed neighbours.
 * @param {string} text
 * @param {{ keepUntimed?: boolean }} [opts]
 * @returns {{ lines: Array<{ t: number, text: string, section?: string }>,
 *   meta: { ti?: string, ar?: string, al?: string, length?: number, offsetMs?: number }, untimed: number }}
 */
export function parseLrc(text, { keepUntimed = false } = {}) {
  const meta = {}
  // Source items in order: { times: number[] } for timed lines, { times: null } for untimed ones.
  const items = []
  let untimed = 0
  let pendingSection = null
  for (const raw of splitLines(text)) {
    const s = raw.trim()
    if (s === '') continue
    const mm = META_LINE.exec(s)
    if (mm) {
      readMeta(meta, mm[1], mm[2])
      continue
    }
    const { times, rest } = readTagRun(s)
    if (times.length === 0) {
      const label = parseSectionHeader(s)
      if (label !== null) {
        pendingSection = label
        continue
      }
      untimed++
      if (!keepUntimed) continue
    }
    const item = { times: times.length ? times : null, text: cleanText(times.length ? rest : s) }
    if (item.text !== '' && pendingSection !== null) {
      item.section = pendingSection
      pendingSection = null
    }
    items.push(item)
  }

  const shift = (meta.offsetMs ?? 0) / 1000
  const entries = []
  let ta = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.times) {
      const times = item.times.map((t) => Math.max(0, t - shift))
      for (const t of times) entries.push(makeLine(t, item))
      ta = times[0]
      continue
    }
    let j = i
    while (j < items.length && !items[j].times) j++
    const tb = j < items.length ? Math.max(0, items[j].times[0] - shift) : null
    const ts = interpolate(ta, tb, j - i)
    for (let k = i; k < j; k++) entries.push(makeLine(ts[k - i], items[k]))
    i = j - 1
  }
  return { lines: finishLines(entries), meta, untimed }
}

function makeLine(t, item) {
  const line = { t, text: item.text }
  if (item.section) line.section = item.section
  return line
}

const pad = (n, w = 2) => String(n).padStart(w, '0')

function stamp(t) {
  const cs = Math.round((Number.isFinite(t) ? Math.max(0, t) : 0) * 100)
  return `[${pad(Math.floor(cs / 6000))}:${pad(Math.floor((cs % 6000) / 100))}.${pad(cs % 100)}]`
}

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim()

/** "[Label]" for a sung line's section, or null when the label wouldn't parse back as a header. */
function headerFor(line) {
  if (!line.section || line.text === '') return null
  const header = `[${oneLine(line.section)}]`
  return parseSectionHeader(header) !== null ? header : null
}

/**
 * Serializes lines as LRC: [ti:]/[ar:]/[al:]/[length:m:ss] from meta, then "[mm:ss.xx]text" per
 * line, each sectioned sung line preceded by its "[Label]" (only labels that parseSectionHeader
 * accepts, so they parse back as sections). Never emits [offset:].
 * @param {Array<{ t: number, text: string, section?: string }>} lines
 * @param {{ ti?: string, ar?: string, al?: string, length?: number }} [meta]
 * @returns {string}
 */
export function serializeLrc(lines, meta = {}) {
  const out = []
  for (const k of ['ti', 'ar', 'al']) {
    if (typeof meta?.[k] === 'string' && oneLine(meta[k]) !== '') out.push(`[${k}:${oneLine(meta[k])}]`)
  }
  if (typeof meta?.length === 'number' && Number.isFinite(meta.length) && meta.length > 0) {
    out.push(`[length:${formatTime(meta.length)}]`)
  }
  for (const l of lines || []) {
    const header = headerFor(l)
    if (header) out.push(header)
    out.push(stamp(l.t) + oneLine(l.text))
  }
  return out.join('\n')
}

/**
 * Parses plain lyrics into lines without times. Blank-line runs become one '' gap marker, and
 * section headers label the next lyric line (inserting a gap before it when needed).
 * @param {string} text
 * @returns {Array<{ text: string, section?: string }>}
 */
export function parsePlain(text) {
  const out = []
  let gap = false
  let section = null
  for (const raw of splitLines(text)) {
    const s = raw.trim().replace(/\s+/g, ' ')
    if (s === '') {
      if (out.length) gap = true
      continue
    }
    const label = parseSectionHeader(s)
    if (label !== null) {
      section = label
      if (out.length) gap = true
      continue
    }
    if (gap) out.push({ text: '' })
    gap = false
    const line = { text: s }
    if (section !== null) line.section = section
    section = null
    out.push(line)
  }
  return out
}

/** Plain text from lines: one line per entry, '' → blank line, sections as "[Label]" headers. */
function linesToPlain(lines) {
  const out = []
  for (const l of lines) {
    const header = headerFor(l)
    if (header) out.push(header)
    out.push(l.text)
  }
  return out.join('\n')
}

/**
 * Text for the edit textarea: LRC for synced/tapped songs, the plain text for estimated ones.
 * @param {{ timing: string, lines: Array, rawPlain?: string }} song
 * @returns {string}
 */
export function lyricsToEditableText(song) {
  if (song.timing === 'synced' || song.timing === 'tapped') return serializeLrc(song.lines)
  if (typeof song.rawPlain === 'string' && song.rawPlain.trim() !== '') return song.rawPlain
  return linesToPlain(song.lines || [])
}
