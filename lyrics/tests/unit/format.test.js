import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clamp, escapeHtml, formatOffset, formatTime, normalizeForMatch, parseTime } from '../../js/format.js'

/** Deterministic PRNG for property tests. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('clamp: inside, below, above, NaN → lo', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(11, 0, 10), 10)
  assert.equal(clamp(NaN, 3, 10), 3)
  assert.equal(clamp(undefined, 3, 10), 3)
  assert.equal(clamp(Infinity, 0, 10), 10)
  assert.equal(clamp(-Infinity, 0, 10), 0)
  assert.equal(clamp(5, 0, Infinity), 5)
})

test('formatTime: m:ss, floors, h:mm:ss, invalid → 0:00', () => {
  assert.equal(formatTime(75.4), '1:15')
  assert.equal(formatTime(75.99), '1:15')
  assert.equal(formatTime(0), '0:00')
  assert.equal(formatTime(9), '0:09')
  assert.equal(formatTime(59.999), '0:59')
  assert.equal(formatTime(600), '10:00')
  assert.equal(formatTime(3599), '59:59')
  assert.equal(formatTime(3600), '1:00:00')
  assert.equal(formatTime(3723), '1:02:03')
  assert.equal(formatTime(-1), '0:00')
  assert.equal(formatTime(NaN), '0:00')
  assert.equal(formatTime(Infinity), '0:00')
  assert.equal(formatTime('75'), '0:00')
})

test('formatOffset: sign, one decimal, U+2212 minus', () => {
  assert.equal(formatOffset(0.5), '+0.5s')
  assert.equal(formatOffset(-1), '\u22121.0s')
  assert.equal(formatOffset(0), '0.0s')
  assert.equal(formatOffset(-0), '0.0s')
  assert.equal(formatOffset(0.04), '0.0s')
  assert.equal(formatOffset(-0.04), '0.0s')
  assert.equal(formatOffset(12.25), '+12.3s')
  assert.equal(formatOffset(-30), '\u221230.0s')
  assert.equal(formatOffset(NaN), '0.0s')
})

test('parseTime: valid forms', () => {
  assert.equal(parseTime('3:25'), 205)
  assert.equal(parseTime('03:25'), 205)
  assert.equal(parseTime('205'), 205)
  assert.equal(parseTime('3:25.5'), 205.5)
  assert.equal(parseTime('1:02:03'), 3723)
  assert.equal(parseTime(' 3:05 '), 185)
  assert.equal(parseTime('0:00'), 0)
  assert.equal(parseTime('12.5'), 12.5)
})

test('parseTime: invalid forms → null', () => {
  for (const s of ['', 'abc', '3:75', '-1', '1:2:3:4', ':30', '3:', '1:60:00', '3:25:', '3.5:10', '1e3', null, undefined, {}]) {
    assert.equal(parseTime(s), null, String(s))
  }
})

test('parseTime ∘ formatTime round-trips whole seconds (property)', () => {
  const rnd = mulberry32(7)
  for (let i = 0; i < 2000; i++) {
    const sec = rnd() * 40000
    assert.equal(parseTime(formatTime(sec)), Math.floor(sec), String(sec))
  }
})

test('normalizeForMatch: case, diacritics, feat, brackets, suffixes, &', () => {
  assert.equal(normalizeForMatch('Héllo  Wörld'), 'hello world')
  assert.equal(normalizeForMatch('Paper Lanterns (feat. The Fixtures)'), 'paper lanterns')
  assert.equal(normalizeForMatch('Paper Lanterns (ft. Someone)'), 'paper lanterns')
  assert.equal(normalizeForMatch('Paper Lanterns [Bonus Track]'), 'paper lanterns')
  assert.equal(normalizeForMatch('Paper Lanterns - Remastered 2011'), 'paper lanterns')
  assert.equal(normalizeForMatch('Paper Lanterns - Remaster'), 'paper lanterns')
  assert.equal(normalizeForMatch('Paper Lanterns - Live at the Fixture Hall'), 'paper lanterns')
  assert.equal(normalizeForMatch('Paper Lanterns - Radio Edit'), 'paper lanterns')
  assert.equal(normalizeForMatch('Salt & Signal'), 'salt and signal')
  assert.equal(normalizeForMatch('  Jay-Z!!  '), 'jay z')
  assert.equal(normalizeForMatch("Don't Stop"), 'don t stop')
  assert.equal(normalizeForMatch(''), '')
  assert.equal(normalizeForMatch(null), '')
})

test('normalizeForMatch: keeps a dash inside words and non-suffix parentheses', () => {
  assert.equal(normalizeForMatch('Lively - Livewire'), 'lively livewire')
  assert.equal(normalizeForMatch('Feathers (Reprise)'), 'feathers reprise')
})

test('normalizeForMatch: non-Latin scripts are kept, so different titles stay different', () => {
  assert.equal(normalizeForMatch('Ночь'), 'ночь')
  assert.notEqual(normalizeForMatch('夜の歌'), normalizeForMatch('朝の歌'))
  assert.notEqual(normalizeForMatch('夜の歌'), '')
})

test('normalizeForMatch is idempotent (property)', () => {
  const rnd = mulberry32(11)
  const alphabet = 'aAéÉ &-()[]feat. LiveRemastered0123ßøñ!?\''
  for (let i = 0; i < 1000; i++) {
    let s = ''
    const len = Math.floor(rnd() * 30)
    for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)]
    const once = normalizeForMatch(s)
    assert.equal(normalizeForMatch(once), once, JSON.stringify(s))
    assert.match(once, /^(?:[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*)?$/u)
  }
})

test('escapeHtml escapes the five special characters', () => {
  assert.equal(escapeHtml('<a href="x">Tom & \'Jerry\'</a>'), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;')
  assert.equal(escapeHtml('plain'), 'plain')
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(42), '42')
})
