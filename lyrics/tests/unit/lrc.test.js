import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  TIME_TAG, SECTION_WORDS, isLrc, lyricsToEditableText, parseLrc, parsePlain, parseSectionHeader, serializeLrc,
} from '../../js/lrc.js'

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

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

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps
const ts = (lines) => lines.map((l) => l.t)
const texts = (lines) => lines.map((l) => l.text)

function assertTimes(actual, expected, eps = 1e-9) {
  assert.equal(actual.length, expected.length, `length ${JSON.stringify(actual)}`)
  actual.forEach((t, i) => assert.ok(near(t, expected[i], eps), `t[${i}] = ${t}, expected ${expected[i]}`))
}

/** Checks sort order and every gap-marker invariant. */
function assertInvariants(lines) {
  const sungT = new Set(lines.filter((l) => l.text !== '').map((l) => l.t))
  lines.forEach((l, i) => {
    assert.ok(Number.isFinite(l.t) && l.t >= 0, `t[${i}] finite ≥ 0`)
    if (i > 0) assert.ok(lines[i - 1].t <= l.t, `sorted at ${i}`)
    if (l.text === '') {
      assert.ok(i > 0, 'no leading marker')
      assert.notEqual(lines[i - 1].text, '', `no consecutive markers at ${i}`)
      assert.ok(!sungT.has(l.t), `marker at ${l.t} shares t with a sung line`)
    }
  })
}

// ---------- TIME_TAG ----------

function tagSeconds(tag) {
  const m = TIME_TAG.exec(tag)
  if (!m || Number(m[2]) > 59) return null
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0)
}

test('TIME_TAG: grammar and the fraction rule', () => {
  assert.equal(tagSeconds('[00:12.5]'), 12.5)
  assert.equal(tagSeconds('[00:12.50]'), 12.5)
  assert.equal(tagSeconds('[00:12.500]'), 12.5)
  assert.equal(tagSeconds('[00:12.05]'), 12.05)
  assert.equal(tagSeconds('[00:20:30]'), 20.3)
  assert.equal(tagSeconds('[1:02]'), 62)
  assert.equal(tagSeconds('[120:00.00]'), 7200)
  assert.equal(TIME_TAG.exec('[0000:00]'), null)
  assert.equal(TIME_TAG.exec('[00:00.0000]'), null)
  assert.equal(TIME_TAG.exec(' [00:01.00]'), null, 'anchored: callers strip whitespace first')
})

test('parseLrc applies the TIME_TAG value rule and rejects seconds ≥ 60', () => {
  const { lines, untimed } = parseLrc('[00:12.5]a\n[00:13.50]b\n[00:14.500]c\n[00:15.05]d\n[00:20:30]e\n[00:60.00]f\n[00:75]g')
  assertTimes(ts(lines), [12.5, 13.5, 14.5, 15.05, 20.3])
  assert.deepEqual(texts(lines), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(untimed, 2)
  assert.equal(isLrc('[00:60.00]x\n[00:61.00]y'), false)
})

test('SECTION_WORDS is the contract list', () => {
  assert.deepEqual([...SECTION_WORDS], ['intro', 'verse', 'pre-chorus', 'prechorus', 'chorus', 'post-chorus', 'hook', 'refrain',
    'bridge', 'breakdown', 'interlude', 'instrumental', 'solo', 'outro', 'tag', 'coda'])
})

// ---------- parseSectionHeader ----------

test('parseSectionHeader: bracket, paren, brace, colon and bare forms', () => {
  const cases = {
    '[Chorus]': 'Chorus',
    '[chorus: Some Name]': 'Chorus',
    '(Verse 2)': 'Verse 2',
    '{Bridge}': 'Bridge',
    '[Pre-Chorus]': 'Pre-Chorus',
    'PRE-CHORUS': 'Pre-Chorus',
    '[post-chorus 2]': 'Post-Chorus 2',
    '[Prechorus]': 'Prechorus',
    'Chorus:': 'Chorus',
    'verse 2:': 'Verse 2',
    'Verse2': 'Verse 2',
    'Outro': 'Outro',
    '  [ hook ]  ': 'Hook',
    '[Verse 1:]': 'Verse 1',
    'instrumental': 'Instrumental',
    '[Tag]': 'Tag',
    '{coda: fade}': 'Coda',
  }
  for (const [line, want] of Object.entries(cases)) assert.equal(parseSectionHeader(line), want, line)
})

test('parseSectionHeader: non-headers → null', () => {
  for (const line of ['[Spoken softly]', 'Chorus: we keep moving', 'chorus line', '[Chorus)', '(Chorus]', '', 'Verse two',
    'We keep moving', '[ti:Title]', '[00:12.00]Chorus', 'Choruses', 'Verse 2 again', null, 42]) {
    assert.equal(parseSectionHeader(line), null, String(line))
  }
})

// ---------- isLrc ----------

test('isLrc: fixtures, ratio rule, metadata and leading whitespace', () => {
  assert.equal(isLrc(fixture('synced-tricky.lrc')), true)
  assert.equal(isLrc(fixture('plain-with-sections.txt')), false)
  assert.equal(isLrc(''), false)
  assert.equal(isLrc('[ti:Only]\n[ar:Metadata]'), false)
  assert.equal(isLrc('[00:01.00]a\nb'), true, 'exactly 50%')
  assert.equal(isLrc('[00:01.00]a\nb\nc'), false, 'below 50%')
  assert.equal(isLrc('[ti:x]\n[ar:y]\n[length:1:00]\n[00:01.00]a\nb'), true, 'metadata is not content')
  assert.equal(isLrc('   [00:01.00]indented\n\n\n'), true)
  assert.equal(isLrc('A line mentioning [00:01.00] in the middle'), false)
})

// ---------- parseLrc ----------

test('parseLrc: synced-tricky.lrc fixture', () => {
  const { lines, meta, untimed } = parseLrc(fixture('synced-tricky.lrc'))
  assertTimes(ts(lines), [4.5, 10, 14.75, 19.8, 24.5, 29.5, 34.5, 39.5, 59.5, 64.5])
  assert.deepEqual(texts(lines), ['First line here', 'Short fraction line', 'Millisecond line', 'Colon fraction line',
    'Out of order line', 'Repeated hook line', '', 'Word level tags', 'Repeated hook line', 'Last line'])
  assert.equal(lines.filter((l) => l.text === '').length, 1, '34.5 is the only marker')
  assert.equal(lines[6].t, 34.5)
  assert.deepEqual(meta, { ti: 'Fixture Tricky', ar: 'Test Signal', length: 90, offsetMs: 500 })
  assert.equal(untimed, 1)
  assertInvariants(lines)
})

test('parseLrc: synced-tricky.lrc with keepUntimed interpolates the untimed line', () => {
  const { lines, untimed } = parseLrc(fixture('synced-tricky.lrc'), { keepUntimed: true })
  assert.equal(untimed, 1)
  const i = lines.findIndex((l) => l.text === 'untimed line that should be ignored')
  assert.equal(i, 8)
  assert.ok(near(lines[i].t, 39.5 + (64.5 - 39.5) / 2))
  assertInvariants(lines)
})

test('parseLrc: CRLF, CR and BOM', () => {
  for (const nl of ['\r\n', '\r', '\n']) {
    const { lines, meta } = parseLrc('\uFEFF[ti:Song]' + nl + '[00:01.00]a' + nl + '[00:02.00]b' + nl)
    assert.deepEqual(lines, [{ t: 1, text: 'a' }, { t: 2, text: 'b' }])
    assert.equal(meta.ti, 'Song')
  }
})

test('parseLrc: leading tag run, whitespace between tags, later brackets stay in the text', () => {
  const { lines } = parseLrc('  [00:12.00] [01:30.00]  Two   times [00:40.00] here [x]  ')
  assert.deepEqual(lines, [{ t: 12, text: 'Two times [00:40.00] here [x]' }, { t: 90, text: 'Two times [00:40.00] here [x]' }])
  const two = parseLrc('[00:12.00][01:30.00]text').lines
  assert.deepEqual(two, [{ t: 12, text: 'text' }, { t: 90, text: 'text' }])
})

test('parseLrc: word tags removed and whitespace collapsed', () => {
  const { lines } = parseLrc('[00:01.00]<00:01.00>Hel<00:01.20>lo   <00:01.50>there <00:02:10>  friend<00:03.00>')
  assert.deepEqual(lines, [{ t: 1, text: 'Hello there friend' }])
})

test('parseLrc: metadata tags are consumed; length via parseTime, invalid length ignored', () => {
  const r = parseLrc('[ti: Title ]\n[ar:Artist]\n[al:Album]\n[au:Writer]\n[by:Maker]\n[re:Tool]\n[ve:1.0]\n[#:comment]\n[length:3:05]\n[00:01.00]a')
  assert.deepEqual(r.meta, { ti: 'Title', ar: 'Artist', al: 'Album', length: 185 })
  assert.equal(r.untimed, 0)
  assert.deepEqual(parseLrc('[length:soon]\n[00:01.00]a').meta, {})
  assert.deepEqual(parseLrc('[LENGTH:90]\n[00:01.00]a').meta, { length: 90 })
})

test('parseLrc: offset sign, decimals, clamp after shifting, last wins, invalid ignored, position anywhere', () => {
  const later = parseLrc('[offset:-1500]\n[00:10.00]a')
  assert.deepEqual(later.lines, [{ t: 11.5, text: 'a' }])
  assert.equal(later.meta.offsetMs, -1500)
  const earlier = parseLrc('[00:10.00]a\n[00:00.20]b\n[offset: +250.5 ]')
  assert.ok(near(earlier.lines[0].t, 0), 'clamped at 0 after shifting')
  assert.ok(near(earlier.lines[1].t, 10 - 0.2505))
  assert.equal(earlier.meta.offsetMs, 250.5)
  const last = parseLrc('[offset:+1000]\n[offset:bogus]\n[offset:+2000]\n[offset:12ms]\n[00:10.00]a')
  assert.deepEqual(last.lines, [{ t: 8, text: 'a' }])
  assert.equal(last.meta.offsetMs, 2000)
  const plainNumber = parseLrc('[offset:500]\n[00:10.00]a')
  assert.deepEqual(plainNumber.lines, [{ t: 9.5, text: 'a' }])
  assert.equal(parseLrc('[offset:]\n[00:10.00]a').meta.offsetMs, undefined)
})

test('parseLrc: clamping to 0 can make equal times; order stays stable', () => {
  const { lines } = parseLrc('[00:00.30]a\n[00:00.10]b\n[00:00.90]c\n[offset:+500]')
  assert.deepEqual(lines.map((l) => [Math.round(l.t * 100) / 100, l.text]), [[0, 'a'], [0, 'b'], [0.4, 'c']])
})

test('parseLrc: sections go on the next timed sung line, skipping markers and covering every tag', () => {
  const { lines, untimed } = parseLrc('[Verse 1]\n[00:01.00]\n[00:02.00]a\n[00:03.00]b\nChorus:\n[00:10.00][00:30.00]hook\n[00:20.00]c\n[Bridge]')
  assert.equal(untimed, 0)
  assert.deepEqual(lines, [
    { t: 2, text: 'a', section: 'Verse 1' },
    { t: 3, text: 'b' },
    { t: 10, text: 'hook', section: 'Chorus' },
    { t: 20, text: 'c' },
    { t: 30, text: 'hook', section: 'Chorus' },
  ])
})

test('parseLrc: keepUntimed=false drops untimed lines but counts them', () => {
  const { lines, untimed } = parseLrc('[00:01.00]a\nfree one\nfree two\n[00:05.00]b')
  assert.deepEqual(texts(lines), ['a', 'b'])
  assert.equal(untimed, 2)
})

test('parseLrc: keepUntimed interpolation between, before, after, and backwards neighbours', () => {
  const between = parseLrc('[00:02.00]a\nx\ny\nz\n[00:10.00]b', { keepUntimed: true }).lines
  assertTimes(ts(between), [2, 4, 6, 8, 10])
  assert.deepEqual(texts(between), ['a', 'x', 'y', 'z', 'b'])

  const before = parseLrc('x\ny\n[00:09.00]a', { keepUntimed: true }).lines
  assertTimes(ts(before), [3, 6, 9])

  const after = parseLrc('[00:09.00]a\nx\ny', { keepUntimed: true }).lines
  assertTimes(ts(after), [9, 11, 13])

  const backwards = parseLrc('[00:30.00]a\nx\ny\n[00:20.00]b', { keepUntimed: true }).lines
  assert.deepEqual(backwards.map((l) => [l.t, l.text]), [[20, 'b'], [30, 'a'], [30, 'x'], [30, 'y']])

  const shifted = parseLrc('[offset:+1000]\n[00:03.00]a\nx\n[00:07.00]b', { keepUntimed: true }).lines
  assertTimes(ts(shifted), [2, 4, 6])
})

test('parseLrc: keepUntimed lines take a pending section header', () => {
  const { lines, untimed } = parseLrc('[00:01.00]a\n[Chorus]\nfree line\n[00:05.00]b', { keepUntimed: true })
  assert.equal(untimed, 1)
  assert.deepEqual(lines, [{ t: 1, text: 'a' }, { t: 3, text: 'free line', section: 'Chorus' }, { t: 5, text: 'b' }])
})

test('parseLrc: empty text → marker; duplicates; marker invariants', () => {
  const dup = parseLrc('[00:05.00]same\n[00:05.00]same\n[00:05.00]other\n[00:05.00][00:05.00]same').lines
  assert.deepEqual(dup, [{ t: 5, text: 'same' }, { t: 5, text: 'other' }])

  const markers = parseLrc('[00:00.00]\n[00:01.00]\n[00:02.00]a\n[00:02.00]\n[00:04.00]\n[00:05.00]\n[00:06.00]b\n[00:09.00]').lines
  assert.deepEqual(markers, [{ t: 2, text: 'a' }, { t: 4, text: '' }, { t: 6, text: 'b' }, { t: 9, text: '' }])
  assertInvariants(markers)

  const onlyMarkers = parseLrc('[00:01.00]\n[00:02.00]').lines
  assert.deepEqual(onlyMarkers, [])
})

test('parseLrc: stable sort by (t, source line, tag position)', () => {
  const { lines } = parseLrc('[00:05.00][00:01.00]first\n[00:01.00]second\n[00:05.00]third\n[00:01.00][00:05.00]fourth')
  assert.deepEqual(lines.map((l) => [l.t, l.text]), [
    [1, 'first'], [1, 'second'], [1, 'fourth'], [5, 'first'], [5, 'third'], [5, 'fourth'],
  ])
})

test('parseLrc: junk input never throws', () => {
  for (const junk of [undefined, null, '', '[', ']]]', '[00:', '[00:1', 42]) {
    const r = parseLrc(junk)
    assert.ok(Array.isArray(r.lines))
  }
})

// ---------- serializeLrc ----------

test('serializeLrc: metadata header, stamps, sections, never [offset:]', () => {
  const out = serializeLrc([
    { t: 0, text: 'zero' },
    { t: 4.5, text: 'a', section: 'Verse 1' },
    { t: 59.999, text: 'rounds up' },
    { t: 61.005, text: '' },
    { t: 6000, text: 'hundred minutes' },
  ], { ti: 'T', ar: 'A', al: 'B', length: 185.7, offsetMs: 500 })
  assert.equal(out, [
    '[ti:T]', '[ar:A]', '[al:B]', '[length:3:05]',
    '[00:00.00]zero',
    '[Verse 1]', '[00:04.50]a',
    '[01:00.00]rounds up',
    '[01:01.01]',
    '[100:00.00]hundred minutes',
  ].join('\n'))
  assert.doesNotMatch(out, /offset/)
  assert.equal(serializeLrc([{ t: 1, text: 'x' }]), '[00:01.00]x')
  assert.equal(serializeLrc([]), '')
})

test('serializeLrc: labels that would not parse back as headers are omitted', () => {
  assert.equal(serializeLrc([{ t: 1, text: 'x', section: 'My Custom Part' }]), '[00:01.00]x')
  assert.equal(serializeLrc([{ t: 1, text: '', section: 'Chorus' }]), '[00:01.00]')
})

test('serializeLrc → parseLrc round-trips the fixture', () => {
  const x = parseLrc(fixture('synced-tricky.lrc'))
  const y = parseLrc(serializeLrc(x.lines, x.meta))
  assertLinesClose(y.lines, x.lines)
  assert.equal(y.meta.length, 90)
  assert.equal(y.meta.offsetMs, undefined)
})

function assertLinesClose(actual, expected) {
  assert.equal(actual.length, expected.length)
  actual.forEach((l, i) => {
    assert.ok(Math.abs(l.t - expected[i].t) <= 0.005 + 1e-9, `t[${i}] ${l.t} vs ${expected[i].t}`)
    assert.deepEqual({ ...l, t: 0 }, { ...expected[i], t: 0 }, `line ${i}`)
  })
}

const WORDS = ['amber', 'lantern', 'velvet', 'echo', 'river', 'paper', 'signal', 'quiet', 'neon', 'harbor', 'drift', 'glow']

function randomLrc(rnd) {
  const out = []
  const n = 1 + Math.floor(rnd() * 25)
  if (rnd() < 0.5) out.push(`[offset:${rnd() < 0.5 ? '+' : '-'}${Math.floor(rnd() * 300) * 10}]`)
  if (rnd() < 0.5) out.push(`[length:${Math.floor(rnd() * 5)}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}]`)
  for (let i = 0; i < n; i++) {
    if (rnd() < 0.15) out.push(`[${SECTION_WORDS[Math.floor(rnd() * SECTION_WORDS.length)]}${rnd() < 0.3 ? ' 2' : ''}]`)
    const tags = []
    const k = rnd() < 0.15 ? 2 : 1
    for (let j = 0; j < k; j++) {
      const cs = Math.floor(rnd() * 360000)
      tags.push(`[${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}]`)
    }
    const words = rnd() < 0.15 ? [] : Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => WORDS[Math.floor(rnd() * WORDS.length)])
    out.push(tags.join('') + words.join(' '))
  }
  return out.join('\n')
}

test('serializeLrc → parseLrc round-trip within ±0.005 s, sections included (property)', () => {
  const rnd = mulberry32(2024)
  for (let iter = 0; iter < 400; iter++) {
    const src = randomLrc(rnd)
    const x = parseLrc(src)
    assertInvariants(x.lines)
    const out = serializeLrc(x.lines, x.meta)
    const y = parseLrc(out)
    assertLinesClose(y.lines, x.lines)
    if (x.lines.length) assert.equal(isLrc(out), true)
  }
})

// ---------- parsePlain ----------

test('parsePlain: plain-with-sections.txt fixture → 4 stanzas with sections', () => {
  const lines = parsePlain(fixture('plain-with-sections.txt'))
  assert.deepEqual(lines, [
    { text: 'Morning traffic hums a tune', section: 'Verse 1' },
    { text: 'Coffee cooling on the sill' },
    { text: '' },
    { text: 'We keep moving, we keep moving', section: 'Chorus' },
    { text: 'Every street is paved with will' },
    { text: '' },
    { text: 'Evening settles on the rooftops', section: 'Verse 2' },
    { text: 'Neon flickers, then stands still' },
    { text: '' },
    { text: 'We keep moving, we keep moving', section: 'Chorus' },
    { text: 'Every street is paved with will' },
  ])
})

test('parsePlain: CRLF, BOM, trimming, collapsing, gap runs, leading/trailing gaps', () => {
  assert.deepEqual(parsePlain('\uFEFF\r\n\r\n  one   two  \r\n\r\n\r\n \t \r\nthree\r\n\r\n'), [
    { text: 'one two' }, { text: '' }, { text: 'three' },
  ])
  assert.deepEqual(parsePlain('a\rb'), [{ text: 'a' }, { text: 'b' }])
  assert.deepEqual(parsePlain(''), [])
  assert.deepEqual(parsePlain('\n\n\n'), [])
})

test('parsePlain: headers insert a gap when needed, dangling headers are dropped, unknown brackets are lyrics', () => {
  assert.deepEqual(parsePlain('a\n[Chorus]\nb'), [{ text: 'a' }, { text: '' }, { text: 'b', section: 'Chorus' }])
  assert.deepEqual(parsePlain('a\n\n[Chorus]\n\nb'), [{ text: 'a' }, { text: '' }, { text: 'b', section: 'Chorus' }])
  assert.deepEqual(parsePlain('[Intro]\n\n[Verse]\na\n[Outro]'), [{ text: 'a', section: 'Verse' }])
  assert.deepEqual(parsePlain('[Spoken softly]\na'), [{ text: '[Spoken softly]' }, { text: 'a' }])
  assert.deepEqual(parsePlain('(Backing la la)\nverse line'), [{ text: '(Backing la la)' }, { text: 'verse line' }])
})

// ---------- lyricsToEditableText ----------

test('lyricsToEditableText: LRC for synced/tapped, rawPlain for estimated', () => {
  const lines = [{ t: 1, text: 'a', section: 'Chorus' }, { t: 2, text: '' }, { t: 3, text: 'b' }]
  assert.equal(lyricsToEditableText({ timing: 'synced', lines, rawPlain: 'ignored' }), '[Chorus]\n[00:01.00]a\n[00:02.00]\n[00:03.00]b')
  assert.equal(lyricsToEditableText({ timing: 'tapped', lines }), '[Chorus]\n[00:01.00]a\n[00:02.00]\n[00:03.00]b')
  assert.equal(lyricsToEditableText({ timing: 'estimated', lines, rawPlain: 'plain text\n\nhere' }), 'plain text\n\nhere')
  assert.equal(lyricsToEditableText({ timing: 'estimated', lines, rawPlain: '' }), '[Chorus]\na\n\nb', 'falls back to the lines')
  assert.deepEqual(parsePlain(lyricsToEditableText({ timing: 'estimated', lines, rawPlain: '' })),
    [{ text: 'a', section: 'Chorus' }, { text: '' }, { text: 'b' }])
})
