// Small pure helpers: clamping, time formatting/parsing, text normalization.

/**
 * Clamps x into [lo, hi]. NaN (or anything that isn't a number) → lo.
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(x, lo, hi) {
  const n = typeof x === 'number' ? x : Number(x)
  if (Number.isNaN(n)) return lo
  return Math.min(Math.max(n, lo), hi)
}

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Formats seconds as "m:ss" (floored), or "h:mm:ss" from one hour.
 * Negative, NaN or non-finite → "0:00".
 * @param {number} sec
 * @returns {string}
 */
export function formatTime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '0:00'
  const total = Math.floor(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/**
 * Formats a per-song offset with one decimal and an explicit sign:
 * 0.5 → "+0.5s", -1 → "−1.0s" (U+2212 minus), anything that rounds to 0 → "0.0s".
 * @param {number} sec
 * @returns {string}
 */
export function formatOffset(sec) {
  const r = typeof sec === 'number' && Number.isFinite(sec) ? Math.round(sec * 10) / 10 : 0
  if (r === 0) return '0.0s'
  return (r > 0 ? '+' : '\u2212') + Math.abs(r).toFixed(1) + 's'
}

const RE_SECONDS = /^(\d+(?:\.\d+)?)$/
const RE_MS = /^(\d+):(\d{1,2}(?:\.\d+)?)$/
const RE_HMS = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/

/**
 * Parses a typed duration/time: "205", "3:25", "03:25", "3:25.5", "1:02:03" (surrounding
 * whitespace allowed) → seconds. Invalid ("", "abc", "3:75", "-1", "1:2:3:4") → null.
 * Not used for LRC time tags.
 * @param {string} str
 * @returns {number|null}
 */
export function parseTime(str) {
  if (typeof str !== 'string' && typeof str !== 'number') return null
  const s = String(str).trim()
  let m = RE_SECONDS.exec(s)
  if (m) return Number(m[1])
  m = RE_MS.exec(s)
  if (m) {
    const sec = Number(m[2])
    return sec < 60 ? Number(m[1]) * 60 + sec : null
  }
  m = RE_HMS.exec(s)
  if (m) {
    const min = Number(m[2])
    const sec = Number(m[3])
    return min < 60 && sec < 60 ? Number(m[1]) * 3600 + min * 60 + sec : null
  }
  return null
}

/**
 * Normalizes a title/artist for fuzzy matching: lowercase, no diacritics, no "(feat. …)",
 * "[…]", " - Remastered …", " - Live …" or " - Radio Edit" suffixes, '&' → 'and', and every
 * run of characters other than letters/digits collapsed to one space, trimmed.
 * @param {string} str
 * @returns {string}
 */
export function normalizeForMatch(str) {
  return String(str ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\((?:feat|ft|featuring)\b[^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+-\s+(?:remaster(?:ed)?|live)\b.*$/, '')
    .replace(/\s+-\s+radio edit\b.*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * Escapes &, <, >, " and ' for safe interpolation into HTML.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}
