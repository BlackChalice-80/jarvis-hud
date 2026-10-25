import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_DURATION, LIMITS, MIGRATIONS, SCHEMA, applyTappedTimes, clockDuration, lastT, newId, normalizeSong, retime,
  sameSong, songFromDemo, songFromLrclib, songFromText, songSummary, updateSongText, validateSongInput,
} from '../../js/song.js'
import { parseLrc, parsePlain, serializeLrc } from '../../js/lrc.js'
import { estimateParams, estimateTimings, lineWeight } from '../../js/timing.js'
import { DEMO_ID, DEMO_LRC, DEMO_META } from '../../js/demo.js'

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

const NOW = 1_760_000_000_000
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const fixtureJson = JSON.parse(readFileSync(new URL('../fixtures/lrclib-search.json', import.meta.url), 'utf8'))
const plainFixture = readFileSync(new URL('../fixtures/plain-with-sections.txt', import.meta.url), 'utf8')

/** Candidate shape from lrclib.js normalizeTrack, built by hand so these tests stand alone. */
function candidate(raw) {
  return {
    lrclibId: raw.id,
    title: raw.trackName ?? raw.name ?? '',
    artist: raw.artistName ?? '',
    album: raw.albumName ?? '',
    duration: raw.duration ?? 0,
    instrumental: !!raw.instrumental,
    hasSynced: !!raw.syncedLyrics,
    hasPlain: !!raw.plainLyrics,
    syncedLyrics: raw.syncedLyrics ?? '',
    plainLyrics: raw.plainLyrics ?? '',
    sungLines: 0,
  }
}

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

/** Every field of a valid schema-1 Song, with the data-model invariants. */
function assertValidSong(s) {
  assert.ok(ID_RE.test(s.id), `id ${s.id}`)
  assert.ok(typeof s.title === 'string' && s.title.length > 0 && s.title.length <= 300)
  assert.equal(typeof s.artist, 'string')
  assert.equal(typeof s.album, 'string')
  assert.ok(s.duration > 0 && s.duration <= 21600, `duration ${s.duration}`)
  assert.ok(['synced', 'estimated', 'tapped'].includes(s.timing))
  assert.ok(Array.isArray(s.lines) && s.lines.length <= 5000)
  const sungT = new Set(s.lines.filter((l) => l.text !== '').map((l) => l.t))
  s.lines.forEach((l, i) => {
    assert.ok(Number.isFinite(l.t) && l.t >= 0)
    assert.equal(typeof l.text, 'string')
    if (i > 0) assert.ok(s.lines[i - 1].t <= l.t)
    if (l.text === '') {
      assert.ok(i > 0 && s.lines[i - 1].text !== '' && !sungT.has(l.t), 'marker invariants')
    }
  })
  if (s.timing !== 'estimated') assert.ok(s.duration >= lastT(s.lines) + 1 - 1e-9, 'duration ≥ lastT + 1')
  else assert.ok(s.lines.every((l) => l.t <= s.duration))
  assert.ok(['lrclib', 'manual', 'demo'].includes(s.source.provider))
  assert.equal(typeof s.rawPlain, 'string')
  assert.equal(typeof s.rawSynced, 'string')
  assert.ok(s.estimate.leadIn === null || Number.isFinite(s.estimate.leadIn))
  assert.ok(s.estimate.outro === null || Number.isFinite(s.estimate.outro))
  assert.ok(s.offset >= -30 && s.offset <= 30)
  assert.ok(s.rate >= 0.5 && s.rate <= 1.5)
  assert.ok(['track', 'band', 'manual'].includes(s.mode))
  assert.equal(typeof s.instrumental, 'boolean')
  for (const k of ['createdAt', 'updatedAt', 'lastPlayedAt', 'playCount']) assert.ok(Number.isFinite(s[k]) && s[k] >= 0, k)
  assert.equal(s.schema, 1)
}

const SONG_KEYS = ['id', 'title', 'artist', 'album', 'duration', 'timing', 'lines', 'source', 'rawPlain', 'rawSynced', 'estimate',
  'offset', 'rate', 'mode', 'instrumental', 'createdAt', 'updatedAt', 'lastPlayedAt', 'playCount', 'schema'].sort()

// ---------- constants and helpers ----------

test('constants', () => {
  assert.equal(SCHEMA, 1)
  assert.equal(DEFAULT_DURATION, 210)
  assert.deepEqual({ ...LIMITS }, { title: 300, lineText: 1000, lines: 5000, duration: 21600 })
  assert.deepEqual({ ...MIGRATIONS }, {})
})

test('newId: randomUUID, then getRandomValues, then Math.random', () => {
  const a = newId()
  assert.ok(ID_RE.test(a))
  assert.notEqual(newId(), a)
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (b) => b.fill(171) } })
    assert.equal(newId(), 'ab'.repeat(16))
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
    const m = newId()
    assert.match(m, /^[0-9a-f]{32}$/)
  } finally {
    Object.defineProperty(globalThis, 'crypto', desc)
  }
})

test('clockDuration adds only a positive offset; lastT', () => {
  assert.equal(clockDuration({ duration: 200, offset: 3 }), 203)
  assert.equal(clockDuration({ duration: 200, offset: -3 }), 200)
  assert.equal(clockDuration({ duration: 200, offset: 0 }), 200)
  assert.equal(clockDuration({ duration: 200 }), 200)
  assert.equal(lastT([]), 0)
  assert.equal(lastT([{ t: 3 }, { t: 9 }, { t: 9 }]), 9)
  assert.equal(lastT(undefined), 0)
})

// ---------- constructors ----------

test('songFromLrclib: synced candidate', () => {
  const cand = candidate(fixtureJson[0])
  const s = songFromLrclib(cand, NOW)
  assertValidSong(s)
  assert.deepEqual(Object.keys(s).sort(), SONG_KEYS)
  assert.equal(s.timing, 'synced')
  assert.deepEqual(s.lines, parseLrc(cand.syncedLyrics).lines)
  assert.equal(s.lines[0].text, 'Paper lanterns over the river')
  assert.equal(s.duration, 184, 'max(cand.duration, lastT + 5)')
  assert.deepEqual(s.source, { provider: 'lrclib', lrclibId: 9001 })
  assert.equal(s.rawPlain, cand.plainLyrics)
  assert.equal(s.rawSynced, cand.syncedLyrics)
  assert.equal(s.title, 'Paper Lanterns')
  assert.equal(s.artist, 'The Placeholders')
  assert.equal(s.album, 'Fixture Sessions')
  assert.equal(s.instrumental, false)
  assert.deepEqual([s.offset, s.rate, s.mode], [0, 1, 'track'])
  assert.deepEqual(s.estimate, { leadIn: null, outro: null })
  assert.deepEqual([s.createdAt, s.updatedAt, s.lastPlayedAt, s.playCount], [NOW, NOW, 0, 0])
})

test('songFromLrclib: synced duration rises to lastT + 5; rawPlain derived from synced lines', () => {
  const cand = { ...candidate(fixtureJson[0]), duration: 30, plainLyrics: '' }
  const s = songFromLrclib(cand, NOW)
  assert.equal(s.duration, 54 + 5)
  assert.equal(s.rawPlain, s.lines.map((l) => l.text).join('\n'))
  assert.match(s.rawPlain, /made\n\nHold the light/)
  assert.equal(songFromLrclib({ ...cand, duration: 0 }, NOW).duration, 59)
})

test('songFromLrclib: plain-only candidate → estimated', () => {
  const cand = candidate(fixtureJson[1])
  const s = songFromLrclib(cand, NOW)
  assertValidSong(s)
  assert.equal(s.timing, 'estimated')
  assert.equal(s.duration, 201.5)
  assert.deepEqual(s.lines, estimateTimings(parsePlain(cand.plainLyrics), 201.5))
  assert.equal(s.rawSynced, '')
  assert.equal(s.rawPlain, cand.plainLyrics)
  assert.equal(songFromLrclib({ ...cand, duration: 0 }, NOW).duration, DEFAULT_DURATION)
})

test('songFromLrclib: synced text without timed lines falls back to plain', () => {
  const cand = { ...candidate(fixtureJson[1]), syncedLyrics: 'no tags here\nat all' }
  assert.equal(songFromLrclib(cand, NOW).timing, 'estimated')
})

test('songFromLrclib: instrumental / no lyrics → no lines, instrumental true', () => {
  const s = songFromLrclib(candidate(fixtureJson[2]), NOW)
  assertValidSong(s)
  assert.deepEqual(s.lines, [])
  assert.equal(s.instrumental, true)
  assert.equal(s.duration, 62)
  const empty = songFromLrclib({ lrclibId: 5, title: '', duration: 0 }, NOW)
  assert.equal(empty.title, 'Untitled')
  assert.equal(empty.instrumental, true)
  assert.equal(empty.duration, 210)
})

test('songFromText: LRC with keepUntimed, untimed count, duration rules', () => {
  const lrc = '[length:1:30]\n[00:05.00]one\nfloating line\n[00:15.00]two'
  const r = songFromText({ title: 'Typed', artist: 'Me', text: lrc }, NOW)
  assertValidSong(r.song)
  assert.equal(r.untimed, 1)
  assert.equal(r.song.timing, 'synced')
  assert.deepEqual(r.song.lines, [{ t: 5, text: 'one' }, { t: 10, text: 'floating line' }, { t: 15, text: 'two' }])
  assert.equal(r.song.duration, 90, 'meta.length')
  assert.equal(r.song.rawSynced, lrc)
  assert.deepEqual(r.song.source, { provider: 'manual' })
  assert.equal(r.song.artist, 'Me')

  assert.equal(songFromText({ title: 'x', text: lrc, duration: 120 }, NOW).song.duration, 120, 'typed wins')
  assert.equal(songFromText({ title: 'x', text: lrc, duration: 10 }, NOW).song.duration, 16, 'typed raised to lastT + 1')
  assert.equal(songFromText({ title: 'x', text: '[00:05.00]a\n[00:15.00]b' }, NOW).song.duration, 20, 'neither → lastT + 5')
  assert.equal(songFromText({ title: 'x', text: '[length:0:10]\n[00:05.00]a\n[00:15.00]b' }, NOW).song.duration, 16)
})

test('songFromText: plain text → estimated; typed or default duration; title fallback', () => {
  const r = songFromText({ title: '  ', text: plainFixture, duration: 150 }, NOW)
  assertValidSong(r.song)
  assert.equal(r.untimed, 0)
  assert.equal(r.song.timing, 'estimated')
  assert.equal(r.song.title, 'Untitled')
  assert.equal(r.song.duration, 150)
  assert.deepEqual(r.song.lines, estimateTimings(parsePlain(plainFixture), 150))
  assert.equal(r.song.rawPlain, plainFixture)
  assert.equal(r.song.rawSynced, '')
  assert.equal(songFromText({ title: 'x', text: 'a\nb' }, NOW).song.duration, DEFAULT_DURATION)
  assert.equal(songFromText({ title: 'x', text: 'a\nb', duration: NaN }, NOW).song.duration, DEFAULT_DURATION)
  assert.equal(songFromText({ title: 'x'.repeat(400), text: 'a' }, NOW).song.title.length, 300)
})

test('songFromDemo: id, provider, synced lines from demo.js, duration', () => {
  const s = songFromDemo(NOW)
  assertValidSong(s)
  assert.equal(s.id, DEMO_ID)
  assert.deepEqual(s.source, { provider: 'demo' })
  assert.equal(s.timing, 'synced')
  assert.equal(s.duration, DEMO_META.duration)
  assert.equal(s.title, DEMO_META.title)
  assert.equal(s.artist, DEMO_META.artist)
  assert.equal(s.album, DEMO_META.album)
  assert.deepEqual(s.lines, parseLrc(DEMO_LRC).lines)
  assert.equal(s.lines[0].t, 9.5, 'the leading [00:00.00] marker is dropped')
  assert.equal(s.rawSynced, DEMO_LRC)
})

// ---------- edits ----------

function estimatedSong() {
  return songFromText({ title: 'Plain', text: plainFixture, duration: 180 }, NOW).song
}

test('updateSongText: LRC makes an estimated song synced, raises duration, keeps offset/rate/mode', () => {
  const base = deepFreeze({ ...estimatedSong(), offset: 2, rate: 0.9, mode: 'band' })
  const lrc = '[00:10.00]alpha\n[03:20.00]omega\nstray'
  const r = updateSongText(base, lrc, NOW + 5)
  assertValidSong(r.song)
  assert.notEqual(r.song, base)
  assert.equal(r.song.id, base.id)
  assert.equal(r.song.timing, 'synced')
  assert.equal(r.untimed, 1)
  assert.deepEqual(r.song.lines.map((l) => [l.t, l.text]), [[10, 'alpha'], [200, 'omega'], [202, 'stray']])
  assert.equal(r.song.rawSynced, lrc)
  assert.equal(r.song.duration, 203, 'max(180, lastT 202 + 1)')
  assert.equal(updateSongText(base, '[00:10.00]alpha\n[03:20.00]omega', NOW).song.duration, 201)
  assert.deepEqual([r.song.offset, r.song.rate, r.song.mode], [2, 0.9, 'band'])
  assert.equal(r.song.updatedAt, NOW + 5)
  assert.equal(r.song.createdAt, base.createdAt)
})

test('updateSongText: tapped stays tapped; plain text becomes estimated with the song estimate', () => {
  const tapped = deepFreeze({ ...songFromDemo(NOW), timing: 'tapped' })
  assert.equal(updateSongText(tapped, '[00:01.00]x', NOW).song.timing, 'tapped')
  assert.equal(updateSongText(tapped, '[00:01.00]x', NOW).song.duration, 156, 'never lowered')

  const synced = deepFreeze({ ...songFromDemo(NOW), estimate: { leadIn: 8, outro: 4 } })
  const r = updateSongText(synced, 'first plain line\nsecond plain line', NOW + 1)
  assertValidSong(r.song)
  assert.equal(r.song.timing, 'estimated')
  assert.equal(r.untimed, 0)
  assert.equal(r.song.rawPlain, 'first plain line\nsecond plain line')
  assert.deepEqual(r.song.lines, estimateTimings(parsePlain(r.song.rawPlain), 156, { leadIn: 8, outro: 4 }))
  assert.equal(r.song.lines[0].t, 8)
  assert.equal(r.song.duration, 156)
})

test('retime: estimated songs re-spread over the new duration; leadIn/outro undefined keep, null auto, number fixed', () => {
  const base = deepFreeze({ ...estimatedSong(), estimate: { leadIn: 6, outro: null } })
  const kept = retime(base, { duration: 240 }, NOW + 9)
  assertValidSong(kept)
  assert.notEqual(kept, base)
  assert.equal(kept.duration, 240)
  assert.deepEqual(kept.estimate, { leadIn: 6, outro: null })
  assert.deepEqual(kept.lines, estimateTimings(parsePlain(base.rawPlain), 240, { leadIn: 6, outro: null }))
  assert.equal(kept.updatedAt, NOW + 9)

  const auto = retime(base, { leadIn: null, outro: 10 }, NOW)
  assert.equal(auto.duration, 180)
  assert.deepEqual(auto.estimate, { leadIn: null, outro: 10 })
  assert.ok(near(auto.lines[0].t, estimateParams(180).leadIn))
  assert.ok(auto.lines.at(-1).t < 170)

  assert.deepEqual(retime(base, {}, NOW).lines, estimateTimings(parsePlain(base.rawPlain), 180, base.estimate),
    'no patch → re-spread with the stored estimate')
  assert.equal(retime(base, { duration: -4 }, NOW).duration, 180, 'invalid duration ignored')
})

test('retime: estimated song with blank rawPlain re-spreads its own lines', () => {
  const base = { ...estimatedSong(), rawPlain: '' }
  const out = retime(base, { duration: 300 }, NOW)
  assert.deepEqual(out.lines.map((l) => l.text), base.lines.map((l) => l.text))
  assert.equal(out.lines[0].section, 'Verse 1')
})

test('retime: spec case — synced, last t = 200, retime({ duration: 180 }) → duration 201, lines unchanged', () => {
  const base = deepFreeze(songFromText({ title: 'S', text: '[00:10.00]a\n[03:20.00]b', duration: 210 }, NOW).song)
  assert.equal(lastT(base.lines), 200)
  const out = retime(base, { duration: 180 }, NOW)
  assert.equal(out.duration, 201)
  assert.deepEqual(out.lines, base.lines)
  assert.notEqual(out, base)
  assert.equal(retime(base, { duration: 400 }, NOW).duration, 400)
  assert.equal(retime(base, {}, NOW).duration, 210)
  assert.deepEqual(retime(base, { leadIn: 3 }, NOW).estimate, { leadIn: 3, outro: null })
})

// ---------- tap sync ----------

function songWith(lines, extra = {}) {
  return normalizeSong({ title: 'Taps', timing: 'estimated', duration: 100, lines, offset: 1.5, rate: 0.9, ...extra }, NOW)
}

test('applyTappedTimes: spec case [A, \'\', B] taps [40, null, 60]', () => {
  const base = deepFreeze(songWith([{ t: 10, text: 'Alpha line here' }, { t: 20, text: '' }, { t: 30, text: 'Beta line' }]))
  const out = applyTappedTimes(base, [40, null, 60], { now: NOW + 1 })
  assertValidSong(out)
  const gw = (lineWeight(base.lines[0], 0) + lineWeight(base.lines[2], 0)) / 2
  const wA = lineWeight(base.lines[0], gw)
  assert.equal(out.lines[0].t, 40)
  assert.ok(near(out.lines[1].t, 40 + (20 * wA) / (wA + gw)))
  assert.equal(out.lines[2].t, 60)
  assert.equal(out.timing, 'tapped')
  assert.equal(out.rawSynced, serializeLrc(out.lines))
  assert.deepEqual([out.offset, out.rate], [1.5, 0.9])
  assert.equal(out.duration, 100)
  assert.equal(out.updatedAt, NOW + 1)
})

test('applyTappedTimes: spec case [A, B] taps [10, null], duration 12 → E = 11.5, B strictly between', () => {
  const base = songWith([{ t: 1, text: 'Alpha' }, { t: 2, text: 'Beta' }], { duration: 12 })
  const out = applyTappedTimes(base, [10, null])
  assert.equal(estimateParams(12).outro, 3)
  const wA = lineWeight(base.lines[0], 3)
  const wB = lineWeight(base.lines[1], 3)
  assert.equal(out.lines[0].t, 10)
  assert.ok(out.lines[1].t > 10 && out.lines[1].t < 11.5)
  assert.ok(near(out.lines[1].t, 10 + (1.5 * wA) / (wA + wB)))
  assert.equal(out.duration, 12)
})

test('applyTappedTimes: no usable taps → the same object', () => {
  const base = songWith([{ t: 1, text: 'Alpha' }, { t: 2, text: 'Beta' }])
  for (const times of [[], [null, null], [NaN, -1], [undefined, Infinity], [1, 2].slice(2), 'junk', null]) {
    assert.equal(applyTappedTimes(base, times), base)
  }
  assert.equal(applyTappedTimes(base, [null, null, 5, 6]), base, 'entries past the last line are ignored')
})

test('applyTappedTimes: lines before the first tap spread from 0; taps forced non-decreasing', () => {
  const base = songWith([{ t: 0, text: 'one' }, { t: 1, text: 'two two' }, { t: 2, text: 'three' }, { t: 3, text: 'four' }])
  const out = applyTappedTimes(base, [null, null, 30, 20], { endTime: 0 })
  const P = base.lines.map((l) => lineWeight(l, 3))
  assert.equal(out.lines[0].t, 0)
  assert.ok(near(out.lines[1].t, (30 * P[0]) / (P[0] + P[1])))
  assert.equal(out.lines[2].t, 30)
  assert.equal(out.lines[3].t, 30, 'the later, smaller tap is raised to 30')
})

test('applyTappedTimes: after the last tap, lines run to D′ \u2212 outro; endTime and taps raise D′', () => {
  const base = songWith([{ t: 0, text: 'one' }, { t: 1, text: 'two' }, { t: 2, text: 'three' }], { duration: 100 })
  const outro = estimateParams(100).outro
  const out = applyTappedTimes(base, [10])
  const W = base.lines.map((l) => lineWeight(l, 3))
  const E = 100 - outro
  assert.ok(near(out.lines[1].t, 10 + ((E - 10) * W[0]) / (W[0] + W[1] + W[2])))
  assert.ok(near(out.lines[2].t, 10 + ((E - 10) * (W[0] + W[1])) / (W[0] + W[1] + W[2])))
  assert.equal(out.duration, 100)

  const ended = applyTappedTimes(base, [10], { endTime: 150 })
  assert.equal(ended.duration, 150)
  const outro150 = estimateParams(150).outro
  assert.ok(near(ended.lines[2].t, 10 + ((150 - outro150 - 10) * (W[0] + W[1])) / (W[0] + W[1] + W[2])))

  const late = applyTappedTimes(base, [null, null, 130])
  assert.equal(late.duration, 131, 'max(D′ = 130, last t + 1)')
})

test('applyTappedTimes: estimate.outro is used, and 1.5 s per remaining line is the minimum', () => {
  const base = songWith([{ t: 0, text: 'a' }, { t: 1, text: 'b' }, { t: 2, text: 'c' }, { t: 3, text: 'd' }],
    { duration: 100, estimate: { leadIn: null, outro: 40 } })
  const out = applyTappedTimes(base, [10])
  const W = base.lines.map((l) => lineWeight(l, 3))
  assert.ok(near(out.lines[3].t, 10 + (50 * (W[0] + W[1] + W[2])) / (W[0] + W[1] + W[2] + W[3])))
  const crowded = applyTappedTimes(base, [95])
  assert.ok(near(crowded.lines[3].t, 95 + (4.5 * 3) / 4), 'E = 95 + 1.5 × 3')
  assert.ok(crowded.duration >= 99.5)
})

test('applyTappedTimes: markers equal in t to a sung line are dropped; sections preserved', () => {
  const base = songWith([{ t: 0, text: 'one', section: 'Verse 1' }, { t: 1, text: '' }, { t: 2, text: 'two', section: 'Chorus' }])
  const out = applyTappedTimes(base, [20, null, 20])
  assert.deepEqual(out.lines, [{ t: 20, text: 'one', section: 'Verse 1' }, { t: 20, text: 'two', section: 'Chorus' }])
  assert.equal(out.rawSynced, '[Verse 1]\n[00:20.00]one\n[Chorus]\n[00:20.00]two')
  assert.equal(out.duration, 100)
})

test('applyTappedTimes: invariants for random taps (property)', () => {
  const rnd = mulberry32(77)
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rnd() * 40)
    const lines = Array.from({ length: n }, (_, i) => ({ t: i, text: i > 0 && rnd() < 0.2 ? '' : `line ${i} la la` }))
    const base = songWith(lines, { duration: 20 + rnd() * 300 })
    const times = base.lines.map(() => (rnd() < 0.4 ? rnd() * 250 : null))
    const out = applyTappedTimes(base, times, { endTime: rnd() * 300 })
    if (!times.some((t) => t !== null)) {
      assert.equal(out, base)
      continue
    }
    assertValidSong(out)
    assert.equal(out.timing, 'tapped')
    assert.equal(out.id, base.id)
    let prev = -Infinity
    const raised = times.map((t) => (t === null ? null : (prev = Math.max(prev, t))))
    for (const l of out.lines) assert.ok(Number.isFinite(l.t))
    // Every sung line keeps its tap (sung lines are never dropped).
    const sungOut = out.lines.filter((l) => l.text !== '')
    const sungIn = base.lines.map((l, i) => [l, raised[i]]).filter(([l]) => l.text !== '')
    assert.equal(sungOut.length, sungIn.length)
    sungIn.forEach(([, tap], k) => { if (tap !== null) assert.ok(near(sungOut[k].t, tap)) })
    assert.equal(out.rawSynced, serializeLrc(out.lines))
  }
})

// ---------- normalize / validate ----------

test('normalizeSong: junk → a valid default song; never throws', () => {
  for (const junk of [undefined, null, 5, 'x', [], {}, { lines: 'nope', duration: 'long', estimate: 4, source: [] }]) {
    const s = normalizeSong(junk, NOW)
    assertValidSong(s)
    assert.deepEqual(Object.keys(s).sort(), SONG_KEYS)
    assert.equal(s.title, 'Untitled')
    assert.equal(s.duration, 210)
    assert.equal(s.timing, 'estimated')
    assert.deepEqual([s.mode, s.rate, s.offset], ['track', 1, 0])
    assert.deepEqual(s.estimate, { leadIn: null, outro: null })
    assert.deepEqual([s.createdAt, s.updatedAt, s.lastPlayedAt, s.playCount], [NOW, NOW, 0, 0])
  }
  const hostile = { get title() { throw new Error('nope') } }
  assertValidSong(normalizeSong(hostile, NOW))
})

test('normalizeSong: whitelists fields, never spreads the input', () => {
  const input = JSON.parse('{"id":"abc","title":"T","extra":1,"__proto__":{"polluted":true},"readOnly":true,"schema":1}')
  const s = normalizeSong(input, NOW)
  assert.deepEqual(Object.keys(s).sort(), SONG_KEYS)
  assert.equal(s.polluted, undefined)
  assert.equal({}.polluted, undefined)
  assert.equal(s.id, 'abc')
})

test('normalizeSong: clamps and coerces fields', () => {
  const s = normalizeSong({
    id: 'bad id!', title: '  Spaced  ', artist: 5, duration: 99999, timing: 'weird', mode: 'karaoke', rate: 7, offset: -99,
    estimate: { leadIn: 5, outro: 'x' }, source: { provider: 'lrclib', lrclibId: 77 }, instrumental: 'yes',
    playCount: 3.7, lastPlayedAt: -5, createdAt: 10, lines: [{ t: 50000, text: 'far' }, { t: 1, text: 'near' }],
  }, NOW)
  assertValidSong(s)
  assert.notEqual(s.id, 'bad id!')
  assert.equal(s.title, 'Spaced')
  assert.equal(s.artist, '')
  assert.equal(s.duration, 21600)
  assert.equal(s.timing, 'estimated')
  assert.deepEqual([s.mode, s.rate, s.offset], ['track', 1.5, -30])
  assert.deepEqual(s.estimate, { leadIn: 5, outro: null })
  assert.deepEqual(s.source, { provider: 'lrclib', lrclibId: 77 })
  assert.equal(s.instrumental, false)
  assert.equal(s.playCount, 3)
  assert.equal(s.lastPlayedAt, 0)
  assert.deepEqual([s.createdAt, s.updatedAt], [10, 10])
  assert.deepEqual(s.lines, [{ t: 1, text: 'near' }, { t: 21600, text: 'far' }], 'estimated → fit to duration')
  assert.deepEqual(normalizeSong({ source: { provider: 'spotify' } }, NOW).source, { provider: 'manual' })
})

test('normalizeSong: synced/tapped raise duration to lastT + 1 instead of moving lines', () => {
  const s = normalizeSong({ title: 'S', timing: 'synced', duration: 30, lines: [{ t: 5, text: 'a' }, { t: 120, text: 'b' }] }, NOW)
  assert.equal(s.duration, 121)
  assert.deepEqual(s.lines.map((l) => l.t), [5, 120])
  const tapped = normalizeSong({ title: 'S', timing: 'tapped', duration: 300, lines: [{ t: 120, text: 'b' }] }, NOW)
  assert.equal(tapped.duration, 300)
  const capped = normalizeSong({ title: 'S', timing: 'synced', lines: [{ t: 5, text: 'a' }, { t: 30000, text: 'b' }] }, NOW)
  assertValidSong(capped)
  assert.deepEqual(capped.lines, [{ t: 5, text: 'a' }], 'a line past the 6 h limit cannot be kept')
})

test('normalizeSong: schema > SCHEMA → the record as-is plus readOnly (input untouched)', () => {
  const future = deepFreeze({ id: 'future-1', title: 'From v2', schema: 2, lines: 'some new format', extra: { a: 1 } })
  const s = normalizeSong(future, NOW)
  assert.deepEqual(s, { ...future, readOnly: true })
  assert.notEqual(s, future)
  assert.equal(normalizeSong({ title: 'x', schema: 1 }, NOW).readOnly, undefined)
  assert.equal(normalizeSong({ title: 'x' }, NOW).schema, 1, 'missing schema → current')
})

test('normalizeSong applies MIGRATIONS for schema < SCHEMA, in order', () => {
  const calls = []
  MIGRATIONS[0] = (o) => { calls.push(0); return { ...o, title: o.name, schema: 1 } }
  try {
    const s = normalizeSong({ name: 'Old record', schema: 0, lines: [] }, NOW)
    assert.deepEqual(calls, [0])
    assert.equal(s.title, 'Old record')
    assert.equal(s.schema, 1)
    normalizeSong({ title: 'Current', schema: 1 }, NOW)
    assert.deepEqual(calls, [0], 'current records are not migrated')
  } finally {
    delete MIGRATIONS[0]
  }
})

test('normalizeSong is idempotent and keeps valid records intact (property)', () => {
  const rnd = mulberry32(55)
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
  for (let iter = 0; iter < 500; iter++) {
    const rec = {
      id: pick(['ok-id_1', 'bad id', 7, undefined, 'x'.repeat(70)]),
      title: pick(['Song', '', '  ', 'y'.repeat(320) + ' z', null]),
      duration: pick([180, -1, 0, 30000, NaN, '200', 1e-3, undefined]),
      timing: pick(['synced', 'estimated', 'tapped', 'nope']),
      offset: rnd() * 80 - 40,
      rate: rnd() * 2,
      mode: pick(['track', 'band', 'manual', 'x']),
      lines: Array.from({ length: Math.floor(rnd() * 20) }, () => pick([
        { t: rnd() * 400 - 20, text: pick(['', 'la la', 'hey']) },
        { t: 'x', text: 'bad' }, null, { t: rnd() * 400, text: 'with section', section: 'Chorus' },
      ])),
      estimate: pick([undefined, { leadIn: 5, outro: null }, { leadIn: 'x' }]),
      updatedAt: pick([undefined, NOW - 5, -1]),
    }
    const once = normalizeSong(rec, NOW)
    assertValidSong(once)
    assert.deepEqual(normalizeSong(once, NOW + 1000), once)
    assert.deepEqual(normalizeSong(structuredClone(once), NOW), once)
  }
})

test('validateSongInput: accepts a good record and returns it normalized', () => {
  const good = { ...songFromDemo(NOW), junk: 1 }
  const r = validateSongInput(good, NOW)
  assert.equal(r.ok, true)
  assertValidSong(r.song)
  assert.deepEqual(r.song, songFromDemo(NOW))
})

test('validateSongInput: rejections with reasons', () => {
  const base = { title: 'T', lines: [{ t: 1, text: 'a' }], duration: 100 }
  const bad = [
    null, [], 'x',
    { ...base, title: '' }, { ...base, title: '   ' }, { ...base, title: 5 }, { ...base, title: undefined },
    { ...base, lines: undefined }, { ...base, lines: 'a' },
    { ...base, lines: Array.from({ length: 5001 }, (_, i) => ({ t: i, text: 'x' })) },
    { ...base, lines: [{ t: NaN, text: 'a' }] }, { ...base, lines: [{ t: 1, text: 2 }] }, { ...base, lines: [null] },
    { ...base, duration: 0 }, { ...base, duration: -5 }, { ...base, duration: 21601 }, { ...base, duration: NaN },
    { ...base, duration: '100' },
    { ...base, updatedAt: NOW + 86400001 },
  ]
  for (const obj of bad) {
    const r = validateSongInput(obj, NOW)
    assert.equal(r.ok, false, JSON.stringify(obj)?.slice(0, 80))
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.reason.length > 0)
  }
})

test('validateSongInput: truncation, id repair, derived duration, edge limits', () => {
  const r = validateSongInput({ id: 'not valid!', title: 'x'.repeat(400), lines: [{ t: 3, text: 'y'.repeat(1200) }] }, NOW)
  assert.equal(r.ok, true)
  assert.match(r.song.id, ID_RE)
  assert.notEqual(r.song.id, 'not valid!')
  assert.equal(r.song.title.length, 300)
  assert.equal(r.song.lines[0].text.length, 1000)
  assert.equal(r.song.duration, 210, 'missing duration, estimated → 210')

  const synced = validateSongInput({ title: 'S', timing: 'synced', lines: [{ t: 3, text: 'a' }, { t: 40, text: 'b' }] }, NOW)
  assert.equal(synced.song.duration, 45, 'missing duration, synced → lastT + 5')
  const tapped = validateSongInput({ title: 'S', timing: 'tapped', duration: null, lines: [{ t: 40, text: 'b' }] }, NOW)
  assert.equal(tapped.song.duration, 45)

  assert.equal(validateSongInput({ title: 'T', lines: [], duration: 21600 }, NOW).ok, true)
  assert.equal(validateSongInput({ title: 'T', lines: Array.from({ length: 5000 }, (_, i) => ({ t: i, text: 'x' })), duration: 21600 }, NOW).ok, true)
  assert.equal(validateSongInput({ title: 'T', lines: [], updatedAt: NOW + 86400000 }, NOW).ok, true)
  const sid = validateSongInput({ id: 'keep-me_1', title: 'T', lines: [] }, NOW)
  assert.equal(sid.song.id, 'keep-me_1')
})

test('validateSongInput: newer-schema records come back readOnly', () => {
  const r = validateSongInput({ id: 'v2', title: 'Future', schema: 3, lines: [{ t: 1, text: 'a' }], duration: 50 }, NOW)
  assert.equal(r.ok, true)
  assert.equal(r.song.readOnly, true)
  assert.equal(r.song.schema, 3)
})

// ---------- summary / sameSong ----------

test('songSummary', () => {
  const s = { ...songFromDemo(NOW), mode: 'band', playCount: 4, lastPlayedAt: NOW + 3 }
  assert.deepEqual(songSummary(s), {
    id: DEMO_ID, title: 'Soundcheck', artist: 'StageLyrics Demo Band', duration: 156, timing: 'synced', mode: 'band',
    sungLines: s.lines.filter((l) => l.text !== '').length, lastPlayedAt: NOW + 3, playCount: 4,
  })
  assert.equal(songSummary(s).sungLines, 23)
})

test('sameSong compares normalized title and artist', () => {
  assert.equal(sameSong({ title: 'Paper Lanterns', artist: 'The Placeholders' }, { title: 'paper lanterns (feat. Guest)', artist: 'THE PLACEHOLDERS' }), true)
  assert.equal(sameSong({ title: 'Paper Lanterns - Remastered 2011', artist: 'A & B' }, { title: 'Paper  Lanterns', artist: 'a and b' }), true)
  assert.equal(sameSong({ title: 'Paper Lanterns', artist: 'X' }, { title: 'Paper Lanterns', artist: 'Y' }), false)
  assert.equal(sameSong({ title: 'One', artist: '' }, { title: 'Two', artist: '' }), false)
  assert.equal(sameSong({ title: '夜の歌', artist: '' }, { title: '朝の歌', artist: '' }), false)
})
