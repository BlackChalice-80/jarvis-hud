import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activeLineIndex, activeSpan, applyMarkerInvariants, countSyllables, cueIndex, estimateParams, estimateTimings,
  estLineSeconds, firstSungIndex, gapInfo, holdPoint, lastSungIndex, lineEnd, lineProgress, lineWeight, nextSungIndex,
  prevSungIndex, shiftLines, validateLines,
} from '../../js/timing.js'

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
const L = (t, text, section) => (section ? { t, text, section } : { t, text })
const WORDS = ['amber', 'lantern', 'velvet', 'echo', 'river', 'paper', 'signal', 'quiet', 'neon', 'harbor', 'drift', 'glow', 'la']

function randomText(rnd) {
  return Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ')
}

/** Random sorted lines with repeated t values and '' markers (not necessarily invariant-clean). */
function randomLines(rnd, n = Math.floor(rnd() * 30)) {
  const out = []
  let t = rnd() * 5
  for (let i = 0; i < n; i++) {
    if (rnd() > 0.25) t += Math.round(rnd() * 80) / 10
    out.push(L(t, rnd() < 0.2 ? '' : randomText(rnd)))
  }
  return out
}

function assertInvariants(lines) {
  const sungT = new Set(lines.filter((l) => l.text !== '').map((l) => l.t))
  lines.forEach((l, i) => {
    assert.ok(Number.isFinite(l.t) && l.t >= 0)
    if (i > 0) assert.ok(lines[i - 1].t <= l.t, 'sorted')
    if (l.text === '') {
      assert.ok(i > 0, 'no leading marker')
      assert.notEqual(lines[i - 1].text, '', 'no consecutive markers')
      assert.ok(!sungT.has(l.t), 'no marker at a sung t')
    }
  })
}

// ---------- syllables and weights ----------

test('countSyllables: basics, silent e, -le, digits, non-Latin, symbols', () => {
  assert.equal(countSyllables(''), 0)
  assert.equal(countSyllables('...!? ♪ --'), 0)
  assert.equal(countSyllables('a'), 1)
  assert.equal(countSyllables('the'), 1)
  assert.equal(countSyllables('make'), 1)
  assert.equal(countSyllables('whole'), 1)
  assert.equal(countSyllables('table'), 2)
  assert.equal(countSyllables('agree'), 2)
  assert.equal(countSyllables('rhythm'), 1)
  assert.equal(countSyllables('lantern'), 2)
  assert.equal(countSyllables('Paper lanterns drifting'), 6)
  assert.equal(countSyllables('Ünder Ñoño'), 4, 'diacritics stripped (NFD), so these count as Latin words')
  assert.equal(countSyllables("don't"), 1)
  assert.equal(countSyllables('99 and 2024'), 3)
  assert.equal(countSyllables('夜の歌'), 2)
  assert.equal(countSyllables('Ночь'), 2)
  assert.equal(countSyllables('x'), 1)
})

test('countSyllables never throws and is ≥ 1 for any text with a letter or digit (property)', () => {
  for (const junk of [null, undefined, 42, {}, [], '\uD800']) assert.equal(typeof countSyllables(junk), 'number')
  const rnd = mulberry32(5)
  const pool = 'abcxyzé日本Ж09 .,!?♪-\''
  for (let i = 0; i < 2000; i++) {
    let s = ''
    for (let k = Math.floor(rnd() * 12); k > 0; k--) s += pool[Math.floor(rnd() * pool.length)]
    const n = countSyllables(s)
    if (/[\p{L}\p{N}]/u.test(s)) assert.ok(n >= 1, JSON.stringify(s))
    else assert.equal(n, 0, JSON.stringify(s))
  }
})

test('estLineSeconds and lineWeight', () => {
  assert.equal(estLineSeconds(''), 0)
  assert.equal(estLineSeconds('la'), 1.5, 'clamped up to 1.5')
  assert.ok(near(estLineSeconds('Paper lanterns drifting'), 6 * 0.32))
  assert.equal(estLineSeconds('la '.repeat(40)), 6, 'clamped down to 6')
  assert.equal(estLineSeconds('♪'), 1.5)
  assert.equal(lineWeight({ text: 'la' }, 9), 3)
  assert.equal(lineWeight({ text: 'Paper lanterns drifting' }, 9), 6)
  assert.equal(lineWeight({ text: '' }, 9), 9)
})

// ---------- estimateParams / estimateTimings ----------

test('estimateParams: auto values, fixed values, negatives, bad durations, scaling', () => {
  const p = estimateParams(210)
  assert.ok(near(p.leadIn, 14.7) && near(p.outro, 12.6) && p.duration === 210)
  assert.deepEqual(estimateParams(1000), { duration: 1000, leadIn: 20, outro: 20 })
  assert.deepEqual(estimateParams(30), { duration: 30, leadIn: 4, outro: 3 })
  assert.deepEqual(estimateParams(100, { leadIn: 10, outro: 5 }), { duration: 100, leadIn: 10, outro: 5 })
  assert.deepEqual(estimateParams(100, { leadIn: -5, outro: -1 }), { duration: 100, leadIn: 0, outro: 0 })
  const auto = estimateParams(100, { leadIn: NaN, outro: Infinity })
  assert.ok(near(auto.leadIn, 7) && near(auto.outro, 6), 'non-finite → auto')
  for (const bad of [NaN, Infinity, -5, 0, 0.5, undefined, '200']) assert.equal(estimateParams(bad).duration, 210, String(bad))
  const tiny = estimateParams(5)
  assert.ok(near(tiny.leadIn, 16 / 7) && near(tiny.outro, 12 / 7))
  const big = estimateParams(100, { leadIn: 90, outro: 30 })
  assert.ok(near(big.leadIn + big.outro, 80) && near(big.leadIn / big.outro, 3))
})

test('estimateTimings: spec cases', () => {
  assert.deepEqual(estimateTimings([], 210), [])
  const one = estimateTimings([{ text: 'only line' }], 210)
  assert.equal(one.length, 1)
  assert.ok(near(one[0].t, 14.7))
  assert.ok(near(estimateTimings([{ text: 'a' }, { text: 'b' }], 5)[0].t, 16 / 7), 'duration 5 → leadIn = 16/7')
  const gap = estimateTimings([{ text: '' }], 210)
  assert.ok(Number.isFinite(gap[0].t))
  assert.ok(estimateTimings([{ text: 'a' }, { text: 'b' }], 100, { leadIn: -5 })[0].t >= 0)
  assert.equal(estimateTimings([{ text: 'a' }, { text: 'b' }], 100, { leadIn: -5 })[0].t, 0)
})

test('estimateTimings: weights, gapWeight default, sections, same order', () => {
  const plain = [{ text: 'la', section: 'Intro' }, { text: '' }, { text: 'Paper lanterns drifting' }]
  const out = estimateTimings(plain, 100, { leadIn: 10, outro: 10 })
  // weights: 3, mean sung weight (3 + 6) / 2 = 4.5, 6 → total 13.5, window 80
  assert.deepEqual(out.map((l) => l.text), ['la', '', 'Paper lanterns drifting'])
  assert.equal(out[0].section, 'Intro')
  assert.equal('section' in out[1], false)
  assert.ok(near(out[0].t, 10))
  assert.ok(near(out[1].t, 10 + (80 * 3) / 13.5))
  assert.ok(near(out[2].t, 10 + (80 * 7.5) / 13.5))
  const fixed = estimateTimings(plain, 100, { leadIn: 10, outro: 10, gapWeight: 1 })
  assert.ok(near(fixed[2].t, 10 + (80 * 4) / 10))
  const bad = estimateTimings(plain, 100, { leadIn: 10, outro: 10, gapWeight: -1 })
  assert.ok(near(bad[2].t, out[2].t), 'gapWeight ≤ 0 → mean sung weight')
  assert.ok(near(estimateTimings([{ text: '' }, { text: '' }], 100, { leadIn: 0, outro: 0 })[1].t, 50), 'no sung lines → gapWeight 3')
})

test('estimateTimings: strictly increasing, starts at leadIn, inside the window (property)', () => {
  const rnd = mulberry32(99)
  for (let iter = 0; iter < 500; iter++) {
    const n = 1 + Math.floor(rnd() * 60)
    const plain = Array.from({ length: n }, () => ({ text: rnd() < 0.15 ? '' : randomText(rnd) }))
    const duration = rnd() < 0.1 ? NaN : 1 + rnd() * 900
    const opts = { leadIn: rnd() < 0.5 ? null : rnd() * 60 - 10, outro: rnd() < 0.5 ? null : rnd() * 60 - 10 }
    const p = estimateParams(duration, opts)
    const out = estimateTimings(plain, duration, opts)
    assert.equal(out.length, n)
    assert.ok(near(out[0].t, p.leadIn))
    for (let i = 1; i < n; i++) assert.ok(out[i].t > out[i - 1].t, `strict at ${i}`)
    assert.ok(out[n - 1].t < p.duration - p.outro + 1e-9)
    assert.ok(out.every((l) => l.t >= 0 && Number.isFinite(l.t)))
  }
})

// ---------- lookup ----------

test('activeLineIndex: before, at, between, equal t → last of the run, offset', () => {
  const lines = [L(5, 'a'), L(5, 'b'), L(9, 'c'), L(12, '')]
  assert.equal(activeLineIndex(lines, 4.99), -1)
  assert.equal(activeLineIndex(lines, 5), 1)
  assert.equal(activeLineIndex(lines, 8.9), 1)
  assert.equal(activeLineIndex(lines, 9), 2)
  assert.equal(activeLineIndex(lines, 100), 3)
  assert.equal(activeLineIndex(lines, 6, 2), -1, 'offset delays display')
  assert.equal(activeLineIndex(lines, 7, 2), 1)
  assert.equal(activeLineIndex(lines, 3, -2), 1, 'negative offset shows earlier')
  assert.equal(activeLineIndex([], 5), -1)
  assert.equal(activeLineIndex(lines, NaN), -1)
})

test('activeLineIndex: binary search == linear scan (property)', () => {
  const rnd = mulberry32(42)
  for (let iter = 0; iter < 3000; iter++) {
    const lines = randomLines(rnd)
    const offset = rnd() < 0.3 ? 0 : (rnd() - 0.5) * 20
    const pick = lines.length && rnd() < 0.3 ? lines[Math.floor(rnd() * lines.length)].t + offset : rnd() * 200 - 10
    let linear = -1
    for (let i = 0; i < lines.length; i++) if (lines[i].t + offset <= pick) linear = i
    assert.equal(activeLineIndex(lines, pick, offset), linear)
    const span = activeSpan(lines, pick, offset)
    assert.equal(span.end, linear)
    if (linear === -1) assert.deepEqual(span, { start: -1, end: -1 })
    else {
      assert.equal(lines[span.start].t, lines[span.end].t)
      assert.ok(span.start === 0 || lines[span.start - 1].t !== lines[span.end].t)
    }
  }
})

test('activeSpan: spec case t [5, 5, 9]', () => {
  const lines = [L(5, 'a'), L(5, 'b'), L(9, 'c')]
  assert.deepEqual(activeSpan(lines, 5), { start: 0, end: 1 })
  assert.deepEqual(activeSpan(lines, 4.99), { start: -1, end: -1 })
  assert.deepEqual(activeSpan(lines, 9), { start: 2, end: 2 })
  assert.deepEqual(activeSpan(lines, 7), { start: 0, end: 1 })
  assert.deepEqual(activeSpan(lines, 7, 3), { start: -1, end: -1 })
})

test('next/prev/first/last sung index', () => {
  const lines = [L(1, 'a'), L(2, ''), L(3, 'b'), L(4, ''), L(5, '')]
  assert.equal(nextSungIndex(lines, -1), 0)
  assert.equal(nextSungIndex(lines, 0), 2)
  assert.equal(nextSungIndex(lines, 2), -1)
  assert.equal(prevSungIndex(lines, 2), 0)
  assert.equal(prevSungIndex(lines, 0), -1)
  assert.equal(prevSungIndex(lines, 5), 2)
  assert.equal(firstSungIndex(lines), 0)
  assert.equal(lastSungIndex(lines), 2)
  assert.equal(firstSungIndex([L(1, '')]), -1)
  assert.equal(lastSungIndex([]), -1)
})

// ---------- line end / progress ----------

test('lineEnd: sung lines capped by estimate, markers end at the next start, equal-t runs skipped', () => {
  const lines = [L(10, 'Paper lanterns drifting'), L(11, ''), L(20, 'la'), L(20, 'le'), L(40, 'end of song line')]
  assert.equal(lineEnd(lines, 0, 0, 100), 11)
  assert.equal(lineEnd(lines, 1, 0, 100), 20)
  assert.equal(lineEnd(lines, 2, 0, 100), 21.5, 'next later-t line is 40, estimate 1.5 wins')
  assert.equal(lineEnd([L(10, 'la'), L(10.5, 'x')], 0, 0, 100), 10.5)
  assert.equal(lineEnd([L(10, 'la')], 0, 0, 11), 11, 'duration caps the last line')
  assert.equal(lineEnd([L(10, '')], 0, 2, 50), 50)
  assert.equal(lineEnd([L(10, 'la'), L(30, 'x')], 0, 2, 100), 13.5)
})

test('lineProgress: 0 before, 1 after, linear inside, i < 0 → 0, zero length → 1', () => {
  const lines = [L(10, 'la'), L(20, 'x'), L(20, 'y')]
  assert.equal(lineProgress(lines, -1, 5, 0, 100), 0)
  assert.equal(lineProgress(lines, 0, 9, 0, 100), 0)
  assert.equal(lineProgress(lines, 0, 10.75, 0, 100), 0.5)
  assert.equal(lineProgress(lines, 0, 50, 0, 100), 1)
  assert.equal(lineProgress(lines, 0, 12.75, 2, 100), 0.5, 'offset applied')
  assert.equal(lineProgress(lines, 0, 11.75, 2, 100), 0)
  assert.equal(lineProgress([L(10, 'la')], 0, 10, 0, 10), 1, 'zero length')
  assert.equal(lineProgress([L(10, 'la')], 0, 5, 0, 8), 1, 'negative length')
})

test('lineProgress is within [0, 1] and non-decreasing in time (property)', () => {
  const rnd = mulberry32(3)
  for (let iter = 0; iter < 300; iter++) {
    const lines = randomLines(rnd, 1 + Math.floor(rnd() * 20))
    const i = Math.floor(rnd() * lines.length)
    const offset = (rnd() - 0.5) * 6
    const duration = lines[lines.length - 1].t + rnd() * 30
    let prev = -1
    for (let time = -5; time < duration + 10; time += 0.37) {
      const p = lineProgress(lines, i, time, offset, duration)
      assert.ok(p >= 0 && p <= 1)
      assert.ok(p >= prev)
      prev = p
    }
  }
})

// ---------- gaps and holds ----------

// The spec's "sung at 10 (est 2 s)" line: 6 syllables → 1.92 s, so the break starts at 11.92.
const SIX = 'Paper lanterns drifting'

test('gapInfo: spec break case (sung at 10 and 30, threshold 6)', () => {
  assert.equal(countSyllables(SIX), 6)
  const lines = [L(10, SIX), L(30, 'Hold the light')]
  assert.equal(gapInfo(lines, 11.9, 0, 60), null)
  const g = gapInfo(lines, 12, 0, 60)
  assert.equal(g.kind, 'break')
  assert.equal(g.nextIndex, 1)
  assert.equal(g.secondsUntilNext, 18)
  assert.ok(g.progress >= 0 && g.progress < 0.005, `progress ${g.progress} ≈ 0`)
  const start = gapInfo(lines, 10 + estLineSeconds(SIX), 0, 60)
  assert.equal(start.progress, 0, 'progress is exactly 0 where the wait starts')
  const late = gapInfo(lines, 29.5, 0, 60)
  assert.equal(late.kind, 'break')
  assert.equal(late.secondsUntilNext, 0.5)
  assert.equal(Math.ceil(late.secondsUntilNext), 1)
  assert.equal(gapInfo(lines, 30, 0, 60), null)
})

test('gapInfo: a marker starts the break early; threshold; intro; outro; empty', () => {
  const marked = [L(10, SIX), L(11, ''), L(30, 'Hold the light')]
  assert.equal(gapInfo(marked, 10.9, 0, 60), null)
  const g = gapInfo(marked, 11, 0, 60)
  assert.equal(g.kind, 'break')
  assert.equal(g.progress, 0)
  assert.equal(g.secondsUntilNext, 19)

  assert.equal(gapInfo([L(10, SIX), L(15, 'x')], 12, 0, 60), null, 'shorter than the threshold')
  assert.notEqual(gapInfo([L(10, SIX), L(15, 'x')], 12, 0, 60, 3), null, 'custom threshold')

  assert.equal(gapInfo([L(4, 'first')], 0, 0, 60), null, 'first sung line at display time 4 → no intro')
  assert.equal(gapInfo([L(2, 'first')], 0, 2, 60), null, 'display time 4 via offset → no intro')
  const intro = gapInfo([L(9.5, 'first'), L(14, 'second')], 3, 0, 60)
  assert.deepEqual(intro, { kind: 'intro', nextIndex: 0, secondsUntilNext: 6.5, progress: 3 / 9.5 })
  assert.equal(gapInfo([L(9.5, 'first')], 0, 0, 60).progress, 0)
  assert.equal(gapInfo([L(9.5, 'first')], -1, 0, 60), null)

  const outro = gapInfo([L(10, 'la')], 20, 0, 60)
  assert.deepEqual(outro, { kind: 'outro', nextIndex: -1, secondsUntilNext: 40, progress: (20 - 11.5) / (60 - 11.5) })
  assert.equal(gapInfo([L(10, 'la')], 11, 0, 60), null, 'outro has not started yet')
  assert.equal(gapInfo([L(10, 'la')], 11.6, 0, 15), null, 'outro shorter than the threshold')

  assert.equal(gapInfo([], 5, 0, 60), null)
  assert.equal(gapInfo([L(1, ''), L(5, '')], 3, 0, 60), null, 'no sung lines')
})

test('gapInfo: the break starts after the whole equal-t run', () => {
  const lines = [L(10, 'la'), L(10, SIX), L(30, 'x')]
  assert.equal(gapInfo(lines, 11.6, 0, 60), null, 'still inside the longer second row')
  assert.equal(gapInfo(lines, 11.92, 0, 60).kind, 'break')
})

test('gapInfo: progress within [0,1], secondsUntilNext ≥ 0, nextIndex sung (property)', () => {
  const rnd = mulberry32(17)
  for (let iter = 0; iter < 400; iter++) {
    const lines = applyMarkerInvariants(randomLines(rnd))
    const offset = (rnd() - 0.5) * 10
    const duration = (lines.length ? lines[lines.length - 1].t : 0) + 5 + rnd() * 40
    for (let k = 0; k < 20; k++) {
      const time = rnd() * (duration + 5)
      const g = gapInfo(lines, time, offset, duration)
      if (!g) continue
      assert.ok(g.progress >= 0 && g.progress <= 1)
      assert.ok(g.secondsUntilNext >= 0)
      if (g.kind === 'outro') assert.equal(g.nextIndex, -1)
      else {
        assert.notEqual(lines[g.nextIndex].text, '')
        assert.ok(lines[g.nextIndex].t + offset > time)
        const h = holdPoint(lines, time, offset, duration)
        assert.equal(h.nextIndex, g.nextIndex)
        const waitEnd = lines[g.nextIndex].t + offset
        assert.ok(near(waitEnd - h.at, 0.45, 1e-9), 'holds lead seconds before the next line')
        if (g.progress > 0 && g.progress < 1) {
          const waitLen = (waitEnd - time) / (1 - g.progress)
          assert.ok(waitLen >= 6 - 1e-6, 'wait is at least the threshold')
          assert.ok(h.at > waitEnd - waitLen, 'at lies inside the wait')
        }
      }
    }
  }
})

test('holdPoint: intro and break hold before the next line; outro never holds', () => {
  const lines = [L(9.5, 'first'), L(10, SIX), L(30, 'Hold the light')]
  assert.deepEqual(holdPoint(lines, 2, 0, 60), { at: 9.05, nextIndex: 0 })
  const h = holdPoint(lines, 20, 0, 60)
  assert.equal(h.nextIndex, 2)
  assert.ok(near(h.at, 29.55))
  assert.ok(near(holdPoint(lines, 20, 1, 60, { lead: 1 }).at, 30))
  assert.equal(holdPoint(lines, 50, 0, 60), null, 'outro')
  assert.equal(holdPoint(lines, 20, 0, 60, { threshold: 25 }), null)
  assert.equal(holdPoint([], 5, 0, 60), null)
})

// ---------- cues ----------

test('cueIndex: spec case lines [\'\' @0, A @9.5, B @14.2]', () => {
  const lines = [L(0, ''), L(9.5, 'A'), L(14.2, 'B')]
  assert.equal(cueIndex(lines, 0, 0, 'next', { started: false }), 1, 'not started → A')
  assert.equal(cueIndex(lines, 0, 0, 'prev', { started: false }), -1)
  assert.equal(cueIndex(lines, 5, 0, 'next'), 1, 'before the first line → A')
  assert.equal(cueIndex(lines, 5, 0, 'prev'), -1)
  assert.equal(cueIndex(lines, 10.5, 0, 'next'), 1, 'A lit 1.0 s ago (< snap 1.2): confirm A')
  assert.equal(cueIndex(lines, 12, 0, 'next'), 2, 'at 12 → B')
  assert.equal(cueIndex(lines, 20, 0, 'next'), -1, 'after the last line → -1')
  assert.equal(cueIndex(lines, 15, 0, 'prev'), 1, 'prev from B → A')
  assert.equal(cueIndex(lines, 10.5, 0, 'prev'), 1, 'prev on the first line re-cues it')
})

test('cueIndex: the double-advance case (line lit 0.4 s early → next confirms it)', () => {
  const lines = [L(10, 'A'), L(14, 'B'), L(18, 'C')]
  assert.equal(cueIndex(lines, 14.4, 0, 'next'), 1)
  assert.equal(cueIndex(lines, 15.3, 0, 'next'), 2)
  assert.equal(cueIndex(lines, 14.4, 1, 'next'), 1, 'offset 1: B not lit yet and A lit 3.4 s ago → B')
  assert.equal(cueIndex(lines, 15.4, 1, 'next'), 1, 'offset 1: B lit 0.4 s ago → confirm B')
})

test('cueIndex: snap shrinks to half the distance to the next line', () => {
  const lines = [L(10, 'A'), L(11, 'B'), L(20, 'C')]
  assert.equal(cueIndex(lines, 10.4, 0, 'next'), 0)
  assert.equal(cueIndex(lines, 10.6, 0, 'next'), 1, '0.6 ≥ min(1.2, 0.5) → advance')
  assert.equal(cueIndex(lines, 21, 0, 'next', { snap: 2 }), 2, 'last line, custom snap')
  assert.equal(cueIndex(lines, 23, 0, 'next', { snap: 2 }), -1)
})

test('cueIndex: equal-t pairs move as one', () => {
  const lines = [L(10, 'A1'), L(10, 'A2'), L(20, 'B1'), L(20, 'B2'), L(25, ''), L(30, 'C')]
  assert.equal(cueIndex(lines, 10.3, 0, 'next'), 0)
  assert.equal(cueIndex(lines, 15, 0, 'next'), 2)
  assert.equal(cueIndex(lines, 21, 0, 'prev'), 0, 'prev goes to the start of the previous run')
  assert.equal(cueIndex(lines, 26, 0, 'next'), 5, 'in a marker gap: next after the B run')
  assert.equal(cueIndex(lines, 26, 0, 'prev'), 0, 'in a marker gap: c is the B run, so prev is A1')
  assert.equal(cueIndex(lines, 20.5, 0, 'next'), 2, 'confirm a just-lit pair')
})

test('cueIndex: no sung lines → -1; result is -1 or a sung index (property)', () => {
  assert.equal(cueIndex([], 5, 0, 'next'), -1)
  assert.equal(cueIndex([L(1, '')], 5, 0, 'next'), -1)
  const rnd = mulberry32(8)
  for (let iter = 0; iter < 2000; iter++) {
    const lines = applyMarkerInvariants(randomLines(rnd))
    const time = rnd() * 150
    const offset = (rnd() - 0.5) * 4
    const dir = rnd() < 0.5 ? 'next' : 'prev'
    const i = cueIndex(lines, time, offset, dir, { started: rnd() < 0.9 })
    assert.ok(i === -1 || (i >= 0 && i < lines.length && lines[i].text !== ''))
    if (i > 0) assert.notEqual(lines[i - 1].t, lines[i].t, 'always the start of an equal-t run')
  }
})

// ---------- shift / validate ----------

test('shiftLines: new array, clamps at 0, keeps order and sections', () => {
  const lines = [L(1, 'a', 'Verse'), L(5, ''), L(9, 'b')]
  const out = shiftLines(lines, -3)
  assert.deepEqual(out, [L(0, 'a', 'Verse'), L(2, ''), L(6, 'b')])
  assert.notEqual(out, lines)
  assert.equal(lines[0].t, 1, 'input untouched')
  assert.deepEqual(shiftLines(lines, 100).map((l) => l.t), [101, 105, 109])
})

test('validateLines: drops junk, clamps t, truncates text, sorts stably, applies marker invariants', () => {
  const out = validateLines([
    null, 7, { t: NaN, text: 'x' }, { t: Infinity, text: 'x' }, { t: '3', text: 'x' }, { t: 3, text: 5 }, { t: 3 },
    { t: 4, text: 'b' }, { t: -2, text: 'a' }, { t: 4, text: 'c', section: 'Chorus', junk: true }, { t: 4, text: '' },
    { t: 6, text: '' }, { t: 7, text: '' }, { t: 8, text: 'y'.repeat(1500) },
  ], 100)
  assert.deepEqual(out, [L(0, 'a'), L(4, 'b'), L(4, 'c', 'Chorus'), L(6, ''), L(8, 'y'.repeat(1000))])
  assert.deepEqual(validateLines([{ t: 0, text: '' }, { t: 1, text: 'a' }], 10), [L(1, 'a')], 'leading marker dropped')
})

test('validateLines: fit clamps t ≤ duration only when asked; never throws; ≤ 5000 lines', () => {
  const lines = [L(5, 'a'), L(50, 'b'), L(60, '')]
  assert.deepEqual(validateLines(lines, 40), lines)
  assert.deepEqual(validateLines(lines, 40, { fit: true }), [L(5, 'a'), L(40, 'b')])
  for (const junk of [undefined, null, 'x', 5, {}, [[]]]) assert.deepEqual(validateLines(junk, 10), [])
  const many = Array.from({ length: 6000 }, (_, i) => L(i, 'line ' + i))
  const capped = validateLines(many, 10)
  assert.equal(capped.length, 5000)
  assert.equal(capped[4999].t, 4999)
})

test('validateLines: output always satisfies the invariants and is idempotent (property)', () => {
  const rnd = mulberry32(31)
  for (let iter = 0; iter < 1000; iter++) {
    const raw = randomLines(rnd).sort(() => rnd() - 0.5).map((l) => (rnd() < 0.1 ? { t: l.t - 20, text: l.text } : l))
    const fit = rnd() < 0.5
    const out = validateLines(raw, 60, { fit })
    assertInvariants(out)
    if (fit) assert.ok(out.every((l) => l.t <= 60))
    assert.deepEqual(validateLines(out, 60, { fit }), out)
  }
})
