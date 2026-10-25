// Timing engine: syllable-weighted estimates, line lookup, gaps, holds and cues.
// Notation: D(i) = lines[i].t + offset (display time). "Sung" means text !== ''.
// Every `time` argument is clock time in song seconds; the offset is applied only here.

import { clamp } from './format.js'

const MAX_LINES = 5000
const MAX_TEXT = 1000

const isSung = (line) => line.text !== ''
const D = (lines, i, offset) => lines[i].t + offset

const LATIN_WORD = /^[a-z]+$/
const VOWEL_GROUPS = /[aeiouy]+/g
const CONSONANT_LE = /[^aeiouy]le$/
const CONSONANT_E = /[^aeiouy]e$/

function latinSyllables(word) {
  let n = (word.match(VOWEL_GROUPS) || []).length
  if (word.length > 1 && CONSONANT_E.test(word) && !CONSONANT_LE.test(word)) n -= 1
  return Math.max(1, n)
}

/**
 * Rough syllable count. ≥ 1 for any text with a letter or digit, 0 for '' or symbols only.
 * Latin words count vowel groups minus a silent final 'e' (min 1), a digit group counts 1,
 * other letters count 1 per 2 (rounded up). Never throws.
 * @param {string} text
 * @returns {number}
 */
export function countSyllables(text) {
  if (typeof text !== 'string' || text === '') return 0
  let n = syllableCache.get(text)
  if (n === undefined) {
    // Called per frame through lineEnd(); a bounded memo keeps that cheap.
    if (syllableCache.size >= 4096) syllableCache.clear()
    n = computeSyllables(text)
    syllableCache.set(text, n)
  }
  return n
}

const syllableCache = new Map()

function computeSyllables(text) {
  const s = text.normalize('NFD').toLowerCase().replace(/\p{M}+/gu, '').replace(/['\u2019]/g, '')
  // Runs of a-z, of digits, or of other letters are counted separately.
  const tokens = s.match(/[a-z]+|\p{N}+|[^\P{L}a-z]+/gu) || []
  let total = 0
  for (const tok of tokens) {
    if (LATIN_WORD.test(tok)) total += latinSyllables(tok)
    else if (/^\p{N}+$/u.test(tok)) total += 1
    else total += Math.ceil([...tok].length / 2)
  }
  return total
}

/**
 * Estimated sung length of a line in seconds: '' → 0, else clamp(syllables · 0.32, 1.5, 6).
 * @param {string} text
 * @returns {number}
 */
export function estLineSeconds(text) {
  if (typeof text !== 'string' || text === '') return 0
  return clamp(countSyllables(text) * 0.32, 1.5, 6)
}

/**
 * Weight of a line for spreading time: sung → max(3, syllables); '' marker → gapWeight.
 * @param {{ text: string }} line
 * @param {number} gapWeight
 * @returns {number}
 */
export function lineWeight(line, gapWeight) {
  return line.text === '' ? gapWeight : Math.max(3, countSyllables(line.text))
}

/** Mean of max(3, syllables) over sung lines; 3 when there are none. */
function meanSungWeight(lines) {
  let sum = 0
  let n = 0
  for (const l of lines) {
    if (l.text !== '') {
      sum += lineWeight(l, 0)
      n++
    }
  }
  return n ? sum / n : 3
}

/**
 * Effective estimate parameters. Auto (null) leadIn = clamp(d·0.07, 4, 20), outro = clamp(d·0.06, 3, 20),
 * negatives → 0, scaled down together so leadIn + outro ≤ 0.8·d. A duration that is non-finite or < 1 → 210.
 * @param {number} duration
 * @param {{ leadIn?: number|null, outro?: number|null }} [opts]
 * @returns {{ duration: number, leadIn: number, outro: number }}
 */
export function estimateParams(duration, { leadIn = null, outro = null } = {}) {
  const d = typeof duration === 'number' && Number.isFinite(duration) && duration >= 1 ? duration : 210
  let li = typeof leadIn === 'number' && Number.isFinite(leadIn) ? leadIn : clamp(d * 0.07, 4, 20)
  let ou = typeof outro === 'number' && Number.isFinite(outro) ? outro : clamp(d * 0.06, 3, 20)
  li = Math.max(0, li)
  ou = Math.max(0, ou)
  if (li + ou > 0.8 * d) {
    const k = (0.8 * d) / (li + ou)
    li *= k
    ou *= k
  }
  return { duration: d, leadIn: li, outro: ou }
}

/**
 * Spreads plain lines across the duration by syllable weight, between the lead-in and the outro.
 * t is strictly increasing and t[0] = leadIn. Sections are preserved.
 * @param {Array<{ text: string, section?: string }>} plainLines
 * @param {number} duration
 * @param {{ leadIn?: number|null, outro?: number|null, gapWeight?: number }} [opts]
 * @returns {Array<{ t: number, text: string, section?: string }>}
 */
export function estimateTimings(plainLines, duration, opts = {}) {
  if (!Array.isArray(plainLines) || plainLines.length === 0) return []
  const p = estimateParams(duration, opts)
  const span = p.duration - p.leadIn - p.outro
  const gw = typeof opts.gapWeight === 'number' && Number.isFinite(opts.gapWeight) && opts.gapWeight > 0
    ? opts.gapWeight
    : meanSungWeight(plainLines)
  const weights = plainLines.map((l) => lineWeight(l, gw))
  const total = weights.reduce((a, b) => a + b, 0)
  let before = 0
  return plainLines.map((l, i) => {
    const out = { t: p.leadIn + (span * before) / total, text: l.text }
    if (l.section) out.section = l.section
    before += weights[i]
    return out
  })
}

/**
 * Largest i with D(i) <= time, or -1 (binary search; equal t → the LAST of the run).
 * @param {Array<{ t: number }>} lines sorted by t
 * @param {number} time
 * @param {number} [offset]
 * @returns {number}
 */
export function activeLineIndex(lines, time, offset = 0) {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t + offset <= time) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** Index of the first line of i's equal-t run. */
function runStart(lines, i) {
  let k = i
  while (k > 0 && lines[k - 1].t === lines[i].t) k--
  return k
}

/** Index of the last line of i's equal-t run. */
function runEnd(lines, i) {
  let k = i
  while (k + 1 < lines.length && lines[k + 1].t === lines[i].t) k++
  return k
}

/**
 * The lines shown as current: { start, end } inclusive, where end = activeLineIndex and
 * start is the first line with the same t. Nothing started → { start: -1, end: -1 }.
 * @returns {{ start: number, end: number }}
 */
export function activeSpan(lines, time, offset = 0) {
  const end = activeLineIndex(lines, time, offset)
  if (end === -1) return { start: -1, end: -1 }
  return { start: runStart(lines, end), end }
}

/** Smallest j > i with a sung line, else -1 (i may be -1). */
export function nextSungIndex(lines, i) {
  for (let j = Math.max(-1, i) + 1; j < lines.length; j++) if (isSung(lines[j])) return j
  return -1
}

/** Largest j < i with a sung line, else -1. */
export function prevSungIndex(lines, i) {
  for (let j = Math.min(i, lines.length) - 1; j >= 0; j--) if (isSung(lines[j])) return j
  return -1
}

/** First sung line index, or -1. */
export function firstSungIndex(lines) {
  return nextSungIndex(lines, -1)
}

/** Last sung line index, or -1. */
export function lastSungIndex(lines) {
  return prevSungIndex(lines, lines.length)
}

/**
 * Display time at which line i ends: the next later-t line's D (or duration), capped for sung
 * lines at D(i) + estLineSeconds(text).
 * @returns {number}
 */
export function lineEnd(lines, i, offset, duration) {
  const k = runEnd(lines, i) + 1
  const nextStart = k < lines.length ? D(lines, k, offset) : duration
  const line = lines[i]
  return isSung(line) ? Math.min(nextStart, D(lines, i, offset) + estLineSeconds(line.text)) : nextStart
}

/**
 * 0..1 progress through line i at `time`; i < 0 → 0; a zero-length line → 1.
 * @returns {number}
 */
export function lineProgress(lines, i, time, offset, duration) {
  if (i < 0 || i >= lines.length) return 0
  const start = D(lines, i, offset)
  const len = lineEnd(lines, i, offset, duration) - start
  if (!(len > 0)) return 1
  return clamp((time - start) / len, 0, 1)
}

/**
 * Instrumental wait around `time` (intro, break or outro), or null when there is none of at
 * least `threshold` seconds or it hasn't begun yet.
 * @returns {null | { kind: 'intro'|'break'|'outro', nextIndex: number, secondsUntilNext: number, progress: number }}
 */
export function gapInfo(lines, time, offset, duration, threshold = 6) {
  if (firstSungIndex(lines) === -1) return null
  const a = activeLineIndex(lines, time, offset)
  const s = a === -1 ? -1 : isSung(lines[a]) ? a : prevSungIndex(lines, a)
  const n = nextSungIndex(lines, a)
  let kind, waitStart, waitEnd
  if (s === -1) {
    kind = 'intro'
    waitStart = 0
    waitEnd = D(lines, n, offset)
  } else {
    kind = n === -1 ? 'outro' : 'break'
    waitStart = lineEnd(lines, runEnd(lines, s), offset, duration)
    waitEnd = n === -1 ? duration : D(lines, n, offset)
  }
  const len = waitEnd - waitStart
  if (!(time >= waitStart) || !(len >= threshold)) return null
  return {
    kind,
    nextIndex: n,
    secondsUntilNext: Math.max(0, waitEnd - time),
    progress: clamp((time - waitStart) / len, 0, 1),
  }
}

/**
 * Band mode: where to hold before the next sung line after an intro or break (never the outro).
 * @returns {null | { at: number, nextIndex: number }}
 */
export function holdPoint(lines, time, offset, duration, { threshold = 6, lead = 0.45 } = {}) {
  const g = gapInfo(lines, time, offset, duration, threshold)
  if (!g || g.kind === 'outro') return null
  return { at: D(lines, g.nextIndex, offset) - lead, nextIndex: g.nextIndex }
}

/**
 * Pedal cue: "the line I mean is starting NOW". Returns the sung line index to seek to, or -1.
 * A 'next' press within `snap` s (or half the distance to the next line) of the current line
 * lighting up confirms the current line instead of skipping past it.
 * @param {'next'|'prev'} dir
 * @returns {number}
 */
export function cueIndex(lines, time, offset, dir, { started = true, snap = 1.2 } = {}) {
  const f = firstSungIndex(lines)
  if (f === -1) return -1
  if (!started || !(time >= D(lines, f, offset))) return dir === 'next' ? f : -1
  const span = activeSpan(lines, time, offset)
  let c = isSung(lines[span.start]) ? span.start : prevSungIndex(lines, span.start)
  c = c === -1 ? f : runStart(lines, c)
  const n = nextSungIndex(lines, runEnd(lines, c))
  if (dir === 'next') {
    const s = n === -1 ? snap : Math.min(snap, 0.5 * (D(lines, n, offset) - D(lines, c, offset)))
    return time - D(lines, c, offset) < s ? c : n
  }
  const p = prevSungIndex(lines, c)
  return p === -1 ? c : runStart(lines, p)
}

/**
 * New array with every t moved by delta and clamped at 0 (order kept). The caller raises duration.
 * @returns {Array<{ t: number, text: string, section?: string }>}
 */
export function shiftLines(lines, delta) {
  return lines.map((l) => copyLine(l, Math.max(0, l.t + delta)))
}

function copyLine(l, t) {
  const out = { t, text: l.text }
  if (typeof l.section === 'string' && l.section !== '') out.section = l.section
  return out
}

/**
 * Enforces the gap-marker invariants on lines already sorted by t: drops '' markers that share t
 * with a sung line, keeps only the first of consecutive markers, and drops a leading marker.
 * Returns a new array (line objects are reused).
 * @param {Array<{ t: number, text: string }>} sorted
 * @returns {Array<{ t: number, text: string }>}
 */
export function applyMarkerInvariants(sorted) {
  const sungTimes = new Set()
  for (const l of sorted) if (isSung(l)) sungTimes.add(l.t)
  const out = []
  for (const l of sorted) {
    if (!isSung(l) && (sungTimes.has(l.t) || out.length === 0 || !isSung(out[out.length - 1]))) continue
    out.push(l)
  }
  return out
}

/**
 * Sanitizes lines from any source: drops entries without a finite t or string text, t ≥ 0,
 * text ≤ 1000 chars, stable sort by t, marker invariants, ≤ 5000 lines. fit=true (estimated
 * songs) also clamps t ≤ duration. Never throws.
 * @param {unknown} lines
 * @param {number} duration
 * @param {{ fit?: boolean }} [opts]
 * @returns {Array<{ t: number, text: string, section?: string }>}
 */
export function validateLines(lines, duration, { fit = false } = {}) {
  if (!Array.isArray(lines)) return []
  const max = fit && typeof duration === 'number' && duration >= 0 ? duration : Infinity
  const out = []
  for (const l of lines) {
    if (!l || typeof l !== 'object') continue
    if (typeof l.t !== 'number' || !Number.isFinite(l.t) || typeof l.text !== 'string') continue
    const line = { t: Math.min(Math.max(0, l.t), max), text: l.text.slice(0, MAX_TEXT) }
    if (typeof l.section === 'string' && l.section !== '') line.section = l.section.slice(0, MAX_TEXT)
    out.push(line)
  }
  out.sort((a, b) => a.t - b.t)
  return applyMarkerInvariants(out).slice(0, MAX_LINES)
}
