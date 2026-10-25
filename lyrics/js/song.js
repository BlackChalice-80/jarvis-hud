// Song records: construction from LRCLIB/text/demo, edits, retiming, tap-sync and normalization.

import { clamp, normalizeForMatch } from './format.js'
import { isLrc, parseLrc, parsePlain, serializeLrc } from './lrc.js'
import { estimateParams, estimateTimings, lineWeight, validateLines } from './timing.js'
import { DEMO_ID, DEMO_LRC, DEMO_META } from './demo.js'

/** Current record schema. */
export const SCHEMA = 1
/** Seconds, used when a song's length is unknown. */
export const DEFAULT_DURATION = 210
/** Field limits enforced on import and normalization. */
export const LIMITS = Object.freeze({ title: 300, lineText: 1000, lines: 5000, duration: 21600 })

/** Migrations keyed by the schema they upgrade from: { [fromSchema]: (obj) => obj }. Empty for schema 1. */
export const MIGRATIONS = {}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const TIMINGS = ['synced', 'estimated', 'tapped']
const MODES = ['track', 'band', 'manual']
const PROVIDERS = ['lrclib', 'manual', 'demo']

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
const finite = (x) => typeof x === 'number' && Number.isFinite(x)
const str = (x) => (typeof x === 'string' ? x : '')
const hasSung = (lines) => lines.some((l) => l.text !== '')

/**
 * A new random id: crypto.randomUUID(), else 32 hex chars from getRandomValues, else Math.random.
 * @returns {string}
 */
export function newId() {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Duration of the perform clock: the song plus any positive offset (so late lyrics can finish).
 * @param {{ duration: number, offset?: number }} song
 * @returns {number}
 */
export function clockDuration(song) {
  return song.duration + Math.max(0, finite(song.offset) ? song.offset : 0)
}

/**
 * Largest t among the lines, or 0.
 * @param {Array<{ t: number }>} lines
 * @returns {number}
 */
export function lastT(lines) {
  let max = 0
  for (const l of lines || []) if (finite(l?.t) && l.t > max) max = l.t
  return max
}

/** Plain text derived from timed lines: one text per line, '' markers → blank lines. */
const plainFromLines = (lines) => lines.map((l) => l.text).join('\n')

/** Fields shared by every freshly built song. */
function baseSong(now) {
  return {
    id: newId(),
    title: 'Untitled',
    artist: '',
    album: '',
    duration: DEFAULT_DURATION,
    timing: 'estimated',
    lines: [],
    source: { provider: 'manual' },
    rawPlain: '',
    rawSynced: '',
    estimate: { leadIn: null, outro: null },
    offset: 0,
    rate: 1,
    mode: 'track',
    instrumental: false,
    createdAt: now,
    updatedAt: now,
    lastPlayedAt: 0,
    playCount: 0,
    schema: SCHEMA,
  }
}

const cleanTitle = (t) => str(t).trim().slice(0, LIMITS.title).trim() || 'Untitled'

/**
 * Builds a song from an LRCLIB Candidate (see lrclib.js normalizeTrack).
 * @param {object} cand
 * @param {number} [now] ms epoch
 * @returns {object} Song
 */
export function songFromLrclib(cand, now = Date.now()) {
  const c = isObj(cand) ? cand : {}
  const synced = str(c.syncedLyrics)
  const plain = str(c.plainLyrics)
  const candDuration = finite(c.duration) && c.duration > 0 ? c.duration : 0
  const song = baseSong(now)
  const syncedLines = synced ? parseLrc(synced).lines : []
  if (hasSung(syncedLines)) {
    song.timing = 'synced'
    song.lines = syncedLines
    song.duration = Math.max(candDuration, lastT(syncedLines) + 5)
  } else {
    song.duration = candDuration || DEFAULT_DURATION
    song.lines = plain.trim() ? estimateTimings(parsePlain(plain), song.duration) : []
  }
  song.instrumental = !hasSung(song.lines)
  song.title = cleanTitle(c.title)
  song.artist = str(c.artist)
  song.album = str(c.album)
  song.source = finite(c.lrclibId) ? { provider: 'lrclib', lrclibId: c.lrclibId } : { provider: 'lrclib' }
  song.rawPlain = plain || (song.timing === 'synced' ? plainFromLines(song.lines) : '')
  song.rawSynced = synced
  return normalizeSong(song, now)
}

/**
 * Builds a song from pasted text (plain or LRC, auto-detected).
 * @param {{ title?: string, artist?: string, album?: string, text: string, duration?: number }} input
 * @param {number} [now]
 * @returns {{ song: object, untimed: number }} untimed = LRC lines that had no timestamp (times interpolated)
 */
export function songFromText({ title, artist = '', album = '', text, duration } = {}, now = Date.now()) {
  const body = str(text)
  const typed = finite(duration) && duration > 0 ? duration : 0
  const song = baseSong(now)
  song.title = cleanTitle(title)
  song.artist = str(artist).trim()
  song.album = str(album).trim()
  let untimed = 0
  if (isLrc(body)) {
    const parsed = parseLrc(body, { keepUntimed: true })
    untimed = parsed.untimed
    const want = typed || parsed.meta.length || 0
    song.timing = 'synced'
    song.lines = parsed.lines
    song.duration = want ? Math.max(want, lastT(parsed.lines) + 1) : lastT(parsed.lines) + 5
    song.rawSynced = body
    song.rawPlain = plainFromLines(parsed.lines)
  } else {
    song.duration = typed || DEFAULT_DURATION
    song.lines = estimateTimings(parsePlain(body), song.duration)
    song.rawPlain = body
  }
  song.instrumental = !hasSung(song.lines)
  return { song: normalizeSong(song, now), untimed }
}

/**
 * The built-in demo song (original placeholder lyrics from demo.js).
 * @param {number} [now]
 * @returns {object} Song
 */
export function songFromDemo(now = Date.now()) {
  const song = baseSong(now)
  song.id = DEMO_ID
  song.title = DEMO_META.title
  song.artist = DEMO_META.artist
  song.album = DEMO_META.album
  song.timing = 'synced'
  song.lines = parseLrc(DEMO_LRC).lines
  song.duration = DEMO_META.duration
  song.source = { provider: 'demo' }
  song.rawSynced = DEMO_LRC
  song.rawPlain = plainFromLines(song.lines)
  return normalizeSong(song, now)
}

/**
 * Replaces a song's lyrics with edited text. LRC keeps 'tapped' timing, otherwise becomes 'synced'
 * (duration raised to fit); plain text becomes 'estimated' with the song's estimate settings.
 * @returns {{ song: object, untimed: number }} a NEW song; the input is not mutated
 */
export function updateSongText(song, text, now = Date.now()) {
  const body = str(text)
  const next = cloneSong(song)
  let untimed = 0
  if (isLrc(body)) {
    const parsed = parseLrc(body, { keepUntimed: true })
    untimed = parsed.untimed
    next.timing = song.timing === 'tapped' ? 'tapped' : 'synced'
    next.lines = parsed.lines
    next.rawSynced = body
    next.duration = Math.max(song.duration, lastT(parsed.lines) + 1)
  } else {
    next.timing = 'estimated'
    next.lines = estimateTimings(parsePlain(body), song.duration, song.estimate || {})
    next.rawPlain = body
  }
  next.instrumental = !hasSung(next.lines)
  next.updatedAt = now
  return { song: normalizeSong(next, now), untimed }
}

/** Plain lines to re-estimate from: rawPlain, or the current lines when rawPlain is blank. */
function plainSource(song) {
  if (str(song.rawPlain).trim()) return parsePlain(song.rawPlain)
  return (song.lines || []).map((l) => (l.section ? { text: l.text, section: l.section } : { text: l.text }))
}

const estimateValue = (patch, keep) => (patch === undefined ? keep : finite(patch) ? patch : null)

/**
 * Changes duration and/or the estimate lead-in/outro (undefined = keep, null = auto, number = fixed).
 * Estimated songs are re-spread over the new duration; synced/tapped lines never move and the
 * duration is raised to at least the last line + 1 s.
 * @returns {object} a NEW song
 */
export function retime(song, { duration, leadIn, outro } = {}, now = Date.now()) {
  const next = cloneSong(song)
  const est = song.estimate || {}
  next.estimate = { leadIn: estimateValue(leadIn, est.leadIn ?? null), outro: estimateValue(outro, est.outro ?? null) }
  const d = finite(duration) && duration > 0 ? Math.min(duration, LIMITS.duration) : song.duration
  if (song.timing === 'estimated') {
    next.duration = d
    next.lines = estimateTimings(plainSource(song), d, next.estimate)
  } else {
    next.duration = Math.max(d, lastT(song.lines) + 1)
  }
  next.updatedAt = now
  return normalizeSong(next, now)
}

/** W(a..b) inclusive weight sums via prefix sums: W(a..b) = P[b + 1] - P[a]. */
function prefixWeights(lines) {
  let sum = 0
  let n = 0
  for (const l of lines) {
    if (l.text !== '') {
      sum += lineWeight(l, 0)
      n++
    }
  }
  const gw = n ? sum / n : 3
  const P = [0]
  for (const l of lines) P.push(P[P.length - 1] + lineWeight(l, gw))
  return P
}

/**
 * Turns tap-to-sync timestamps into a 'tapped' song. Untapped lines are interpolated by syllable
 * weight between their tapped neighbours (from 0 before the first tap, towards the outro after the
 * last). Returns the same object when there are no usable taps.
 * @param {object} song
 * @param {Array<number|null|undefined>} times raw song seconds per line index
 * @param {{ endTime?: number, now?: number }} [opts]
 * @returns {object}
 */
export function applyTappedTimes(song, times, { endTime = 0, now = Date.now() } = {}) {
  const lines = song.lines || []
  const n = lines.length
  const T = new Array(n).fill(null)
  const list = Array.isArray(times) ? times : []
  let prev = -Infinity
  let maxTap = -Infinity
  const tapped = []
  for (let i = 0; i < n; i++) {
    const v = list[i]
    if (!finite(v) || v < 0) continue
    T[i] = Math.max(v, prev)
    prev = T[i]
    maxTap = Math.max(maxTap, T[i])
    tapped.push(i)
  }
  if (tapped.length === 0) return song

  let dur = Math.max(finite(song.duration) ? song.duration : 0, finite(endTime) ? endTime : 0, maxTap)
  const P = prefixWeights(lines)
  const W = (a, b) => P[b + 1] - P[a]
  const t = T.slice()

  const f = tapped[0]
  for (let j = 0; j < f; j++) t[j] = (T[f] * W(0, j - 1)) / W(0, f - 1)
  for (let k = 0; k + 1 < tapped.length; k++) {
    const a = tapped[k]
    const b = tapped[k + 1]
    for (let j = a + 1; j < b; j++) t[j] = T[a] + ((T[b] - T[a]) * W(a, j - 1)) / W(a, b - 1)
  }
  const l = tapped[tapped.length - 1]
  if (l < n - 1) {
    const outro = estimateParams(dur, song.estimate || {}).outro
    const E = Math.max(dur - outro, T[l] + 1.5 * (n - 1 - l))
    dur = Math.max(dur, E)
    for (let j = l + 1; j < n; j++) t[j] = T[l] + ((E - T[l]) * W(l, j - 1)) / W(l, n - 1)
  }

  const next = cloneSong(song)
  next.lines = validateLines(lines.map((line, i) => (line.section ? { t: t[i], text: line.text, section: line.section }
    : { t: t[i], text: line.text })), Infinity)
  next.timing = 'tapped'
  next.duration = Math.max(dur, lastT(next.lines) + 1)
  next.rawSynced = serializeLrc(next.lines)
  next.updatedAt = now
  return normalizeSong(next, now)
}

/** A shallow copy with fresh lines/source/estimate objects, so edits never touch the input. */
function cloneSong(song) {
  return {
    ...song,
    lines: (song.lines || []).map((l) => ({ ...l })),
    source: { ...(song.source || {}) },
    estimate: { ...(song.estimate || {}) },
  }
}

function migrate(obj) {
  let rec = obj
  let v = finite(obj.schema) ? Math.floor(obj.schema) : SCHEMA
  for (; v < SCHEMA; v++) if (typeof MIGRATIONS[v] === 'function') rec = MIGRATIONS[v](rec)
  return rec
}

const msOr = (x, fallback) => (finite(x) && x >= 0 ? x : fallback)

/**
 * Coerces any partial/old record into a valid Song (never throws). Builds a new object from
 * whitelisted fields only. A record from a newer schema is returned as a copy with readOnly: true.
 * @param {unknown} obj
 * @param {number} [now]
 * @returns {object} Song
 */
export function normalizeSong(obj, now = Date.now()) {
  try {
    return normalizeRecord(obj, now)
  } catch {
    return normalizeRecord({}, now)
  }
}

function normalizeRecord(obj, now) {
  const input = isObj(obj) ? obj : {}
  if (finite(input.schema) && input.schema > SCHEMA) return { ...input, readOnly: true }
  const o = migrate(input)
  const timing = TIMINGS.includes(o.timing) ? o.timing : 'estimated'
  let duration = finite(o.duration) && o.duration > 0 ? Math.min(o.duration, LIMITS.duration) : DEFAULT_DURATION
  let lines = validateLines(o.lines, duration, { fit: timing === 'estimated' })
  if (timing !== 'estimated') {
    // Keep duration ≤ the limit: lines that would need a longer song are dropped.
    lines = lines.filter((l) => l.t <= LIMITS.duration - 1)
    duration = Math.max(duration, lastT(lines) + 1)
  }
  const src = isObj(o.source) ? o.source : {}
  const source = { provider: PROVIDERS.includes(src.provider) ? src.provider : 'manual' }
  if (finite(src.lrclibId)) source.lrclibId = src.lrclibId
  const est = isObj(o.estimate) ? o.estimate : {}
  const createdAt = msOr(o.createdAt, now)
  return {
    id: typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : newId(),
    title: cleanTitle(o.title),
    artist: str(o.artist).slice(0, LIMITS.title),
    album: str(o.album).slice(0, LIMITS.title),
    duration,
    timing,
    lines,
    source,
    rawPlain: str(o.rawPlain),
    rawSynced: str(o.rawSynced),
    estimate: { leadIn: finite(est.leadIn) ? est.leadIn : null, outro: finite(est.outro) ? est.outro : null },
    offset: finite(o.offset) ? clamp(o.offset, -30, 30) : 0,
    rate: finite(o.rate) ? clamp(o.rate, 0.5, 1.5) : 1,
    mode: MODES.includes(o.mode) ? o.mode : 'track',
    instrumental: o.instrumental === true,
    createdAt,
    updatedAt: msOr(o.updatedAt, createdAt),
    lastPlayedAt: msOr(o.lastPlayedAt, 0),
    playCount: finite(o.playCount) && o.playCount >= 0 ? Math.floor(o.playCount) : 0,
    schema: SCHEMA,
  }
}

/**
 * Validates an imported record → { ok: true, song } (normalized) or { ok: false, reason }.
 * @param {unknown} obj
 * @param {number} [now]
 * @returns {{ ok: true, song: object } | { ok: false, reason: string }}
 */
export function validateSongInput(obj, now = Date.now()) {
  if (!isObj(obj)) return { ok: false, reason: 'Not a song record' }
  if (typeof obj.title !== 'string' || obj.title.trim() === '') return { ok: false, reason: 'Missing title' }
  if (!Array.isArray(obj.lines)) return { ok: false, reason: 'Missing lines' }
  if (obj.lines.length > LIMITS.lines) return { ok: false, reason: `More than ${LIMITS.lines} lines` }
  const lines = []
  for (const l of obj.lines) {
    if (!isObj(l) || !finite(l.t) || typeof l.text !== 'string') return { ok: false, reason: 'Invalid line' }
    const line = { t: l.t, text: l.text.slice(0, LIMITS.lineText) }
    if (typeof l.section === 'string' && l.section !== '') line.section = l.section
    lines.push(line)
  }
  let duration = obj.duration
  if (duration === undefined || duration === null) {
    duration = obj.timing === 'synced' || obj.timing === 'tapped' ? lastT(lines) + 5 : DEFAULT_DURATION
  } else if (!finite(duration) || duration <= 0 || duration > LIMITS.duration) {
    return { ok: false, reason: 'Invalid duration' }
  }
  if (finite(obj.updatedAt) && obj.updatedAt > now + 86400000) return { ok: false, reason: 'updatedAt is in the future' }
  const id = typeof obj.id === 'string' && ID_RE.test(obj.id) ? obj.id : newId()
  const title = obj.title.slice(0, LIMITS.title)
  return { ok: true, song: normalizeSong({ ...obj, id, title, lines, duration }, now) }
}

/**
 * The fields the library list needs.
 * @returns {{ id, title, artist, duration, timing, mode, sungLines, lastPlayedAt, playCount }}
 */
export function songSummary(song) {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    duration: song.duration,
    timing: song.timing,
    mode: song.mode,
    sungLines: (song.lines || []).filter((l) => l.text !== '').length,
    lastPlayedAt: song.lastPlayedAt,
    playCount: song.playCount,
  }
}

/** Same title and artist after normalizeForMatch. */
export function sameSong(a, b) {
  return normalizeForMatch(a?.title) === normalizeForMatch(b?.title) &&
    normalizeForMatch(a?.artist) === normalizeForMatch(b?.artist)
}
