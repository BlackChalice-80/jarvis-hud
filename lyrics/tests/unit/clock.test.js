import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Clock } from '../../js/clock.js'

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

/** Fake time sources: now() is monotonic seconds, wallNow() wall seconds. */
function fake({ now = 100, wall = 1.7e9 } = {}) {
  const s = { now, wall }
  return {
    s,
    now: () => s.now,
    wallNow: () => s.wall,
    advance(dt) { s.now += dt; s.wall += dt },
  }
}

/** A clock wired to fake time plus an event log. */
function setup(opts = {}) {
  const f = fake()
  const clock = new Clock({ now: f.now, wallNow: f.wallNow, ...opts })
  const events = []
  for (const e of ['play', 'pause', 'seek', 'rate', 'ended']) clock.on(e, (d) => events.push([e, d]))
  return { f, clock, events, names: () => events.map(([e]) => e) }
}

test('constructor defaults: paused at 0, rate 1, duration Infinity, real time sources', () => {
  const clock = new Clock()
  assert.equal(clock.time, 0)
  assert.equal(clock.playing, false)
  assert.equal(clock.ended, false)
  assert.equal(clock.rate, 1)
  assert.equal(clock.duration, Infinity)
  assert.equal(new Clock({ duration: 0 }).duration, Infinity, 'invalid duration → Infinity')
  assert.equal(new Clock({ duration: 90 }).duration, 90)
})

test('spec: duration 10, play at 0, advance 12 → time 10, ended, no event until tick(); tick emits ended once', () => {
  const { f, clock, events, names } = setup({ duration: 10 })
  clock.play()
  assert.deepEqual(names(), ['play'])
  f.advance(12)
  for (let i = 0; i < 3; i++) {
    assert.equal(clock.time, 10)
    assert.equal(clock.playing, false)
    assert.equal(clock.ended, true)
  }
  assert.deepEqual(names(), ['play'], 'getters are pure')
  assert.equal(clock.tick(), 10)
  assert.deepEqual(names(), ['play', 'ended'])
  assert.deepEqual(events[1][1], { time: 10 })
  clock.tick()
  f.advance(5)
  clock.tick()
  assert.deepEqual(names(), ['play', 'ended'], 'a second tick emits nothing')
  assert.equal(clock.time, 10)
})

test('playing reads false the moment time reaches duration', () => {
  const { f, clock } = setup({ duration: 10 })
  clock.play()
  f.advance(9.999)
  assert.equal(clock.playing, true)
  f.advance(0.001)
  assert.equal(clock.playing, false)
  assert.equal(clock.ended, true)
})

test('time advances at rate; setRate at time 4 leaves time at 4', () => {
  const { f, clock, events } = setup()
  clock.play()
  f.advance(4)
  assert.equal(clock.time, 4)
  clock.setRate(1.2)
  assert.equal(clock.time, 4)
  assert.deepEqual(events.at(-1), ['rate', { rate: 1.2, time: 4 }])
  f.advance(1)
  assert.ok(near(clock.time, 5.2))
  clock.setRate(1.2)
  assert.equal(events.filter(([e]) => e === 'rate').length, 1, "'rate' only when it changes")
  clock.setRate(9)
  assert.equal(clock.rate, 1.5)
  clock.setRate(0.1)
  assert.equal(clock.rate, 0.5)
  clock.setRate(NaN)
  clock.setRate('1')
  assert.equal(clock.rate, 0.5)
})

test('paused setRate changes rate without moving time', () => {
  const { f, clock } = setup()
  clock.seek(7)
  clock.setRate(0.8)
  f.advance(10)
  assert.equal(clock.time, 7)
  clock.play()
  f.advance(10)
  assert.ok(near(clock.time, 15))
})

test('play/pause are no-ops (no event) when already in that state', () => {
  const { f, clock, names } = setup()
  clock.pause()
  assert.deepEqual(names(), [])
  clock.play()
  clock.play()
  assert.deepEqual(names(), ['play'])
  f.advance(3)
  clock.pause()
  clock.pause()
  assert.deepEqual(names(), ['play', 'pause'])
  assert.equal(clock.time, 3)
  f.advance(3)
  assert.equal(clock.time, 3, 'paused time stands still')
})

test('toggle flips between playing and paused', () => {
  const { f, clock, names } = setup({ duration: 10 })
  clock.toggle()
  assert.equal(clock.playing, true)
  f.advance(2)
  clock.toggle()
  assert.equal(clock.playing, false)
  assert.equal(clock.time, 2)
  clock.toggle()
  f.advance(20)
  clock.toggle()
  assert.deepEqual(names(), ['play', 'pause', 'play', 'ended'], 'toggle past the end only auto-ends')
})

test('play at the end is a no-op; restart is seek(0) then play()', () => {
  const { f, clock, names } = setup({ duration: 10 })
  clock.play()
  f.advance(15)
  clock.play()
  assert.deepEqual(names(), ['play', 'ended'], 'auto-end, then play is a no-op')
  clock.play()
  assert.deepEqual(names(), ['play', 'ended'])
  clock.seek(0)
  clock.play()
  assert.equal(clock.playing, true)
  f.advance(1)
  assert.equal(clock.time, 1)
  assert.deepEqual(names(), ['play', 'ended', 'seek', 'play'])
})

test('seek: clamps, keeps state, reports reason, ignores non-finite', () => {
  const { f, clock, events } = setup({ duration: 100 })
  clock.seek(30)
  assert.deepEqual(events.at(-1), ['seek', { time: 30, reason: 'user' }])
  assert.equal(clock.playing, false)
  clock.seek(-5, 'cue')
  assert.deepEqual(events.at(-1), ['seek', { time: 0, reason: 'cue' }])
  clock.play()
  clock.seek(50, 'hold')
  assert.equal(clock.playing, true)
  f.advance(2)
  assert.equal(clock.time, 52)
  const n = events.length
  clock.seek(NaN)
  clock.seek(Infinity)
  clock.seek(undefined)
  clock.seek('5')
  assert.equal(events.length, n)
  assert.equal(clock.time, 52)
})

test('seek to the end: playing → seek then ended; paused → ended true without an event', () => {
  const a = setup({ duration: 100 })
  a.clock.play()
  a.clock.seek(150)
  assert.deepEqual(a.names(), ['play', 'seek', 'ended'])
  assert.deepEqual(a.events[1][1], { time: 100, reason: 'user' })
  assert.equal(a.clock.ended, true)
  a.clock.tick()
  assert.deepEqual(a.names(), ['play', 'seek', 'ended'])

  const b = setup({ duration: 100 })
  b.clock.seek(100)
  assert.equal(b.clock.ended, true)
  assert.equal(b.clock.playing, false)
  b.clock.tick()
  assert.deepEqual(b.names(), ['seek'])
})

test('nudge seeks relative to the current time with reason nudge', () => {
  const { f, clock, events } = setup({ duration: 100 })
  clock.play()
  f.advance(10)
  clock.nudge(-2.5)
  assert.deepEqual(events.at(-1), ['seek', { time: 7.5, reason: 'nudge' }])
  clock.nudge(-100)
  assert.equal(clock.time, 0)
  clock.nudge(NaN)
  assert.equal(events.at(-1)[1].time, 0)
})

test('auto-end runs at the start of every mutator, with no pause event', () => {
  for (const op of [(c) => c.pause(), (c) => c.play(), (c) => c.seek(3), (c) => c.nudge(-1), (c) => c.setRate(1.3),
    (c) => { c.duration = 50 }]) {
    const { f, clock, names } = setup({ duration: 10 })
    clock.play()
    f.advance(11)
    op(clock)
    assert.equal(names()[1], 'ended', String(op))
    assert.ok(!names().includes('pause'), String(op))
    assert.equal(names().filter((e) => e === 'ended').length, 1)
    assert.equal(clock.playing, false)
  }
})

test('after auto-end, seek back keeps the clock paused', () => {
  const { f, clock } = setup({ duration: 10 })
  clock.play()
  f.advance(11)
  clock.seek(3)
  f.advance(1)
  assert.equal(clock.time, 3)
  assert.equal(clock.ended, false)
})

test('duration setter: validation, paused clamp, raising after the end does not resume', () => {
  const { f, clock, names } = setup({ duration: 100 })
  clock.seek(80)
  clock.duration = 50
  assert.equal(clock.duration, 50)
  assert.equal(clock.time, 50)
  assert.equal(clock.ended, true)
  for (const bad of [0, -1, NaN, null, '200']) clock.duration = bad
  assert.equal(clock.duration, 50)
  clock.duration = 120
  assert.equal(clock.ended, false)
  assert.equal(clock.playing, false)
  assert.equal(clock.time, 50)
  clock.duration = Infinity
  assert.equal(clock.duration, Infinity)
  clock.play()
  f.advance(1000)
  assert.equal(clock.ended, false)
  assert.equal(clock.time, 1050)
  assert.ok(!names().includes('ended'))
})

test('duration setter while playing: raising keeps the run going; lowering past the time ends on the next tick', () => {
  const { f, clock, names } = setup({ duration: 100 })
  clock.play()
  f.advance(30)
  clock.duration = 200
  f.advance(5)
  assert.equal(clock.time, 35)
  clock.duration = 20
  assert.equal(clock.time, 20)
  assert.equal(clock.playing, false)
  clock.tick()
  assert.deepEqual(names(), ['play', 'ended'])
})

test('reset pauses and seeks to 0 with reason reset', () => {
  const { f, clock, events, names } = setup()
  clock.play()
  f.advance(5)
  clock.reset()
  assert.deepEqual(names(), ['play', 'pause', 'seek'])
  assert.deepEqual(events.at(-1)[1], { time: 0, reason: 'reset' })
  assert.equal(clock.playing, false)
  assert.equal(clock.time, 0)
})

test('resync: a 30 s suspension (now +0, wall +30) moves time by +30 × rate', () => {
  const { f, clock, events } = setup()
  clock.play()
  f.advance(4)
  clock.setRate(1.2)
  f.s.wall += 30
  assert.equal(clock.resync(), 30)
  assert.ok(near(clock.time, 4 + 36))
  assert.equal(events.at(-1)[0], 'seek')
  assert.equal(events.at(-1)[1].reason, 'resync')
  assert.ok(near(events.at(-1)[1].time, 40))
  assert.equal(clock.resync(), 0, 're-anchored: no drift left')
  f.advance(1)
  assert.ok(near(clock.time, 41.2))
})

test('resync: backwards wall jumps, tiny and huge drifts, and a paused clock → 0', () => {
  const { f, clock, names } = setup()
  clock.play()
  f.advance(10)
  f.s.wall -= 3600
  assert.equal(clock.resync(), 0, 'never moves time backwards')
  assert.equal(clock.time, 10)

  const b = setup()
  b.clock.play()
  b.f.s.wall += 0.25
  assert.equal(b.clock.resync(), 0, 'drift must exceed 0.25 s')
  b.f.s.wall += 21600
  assert.equal(b.clock.resync(), 0, 'drift must be under 21600 s')

  const c = setup()
  c.f.s.wall += 30
  assert.equal(c.clock.resync(), 0, 'paused')
  c.clock.seek(5)
  c.f.s.wall += 30
  assert.equal(c.clock.resync(), 0)
  assert.equal(c.clock.time, 5)
  assert.deepEqual(c.names(), ['seek'], 'only the user seek, no resync seek')
  assert.deepEqual(names(), ['play'])
})

test('resync near the end clamps to duration and the next tick ends the run', () => {
  const { f, clock, names } = setup({ duration: 20 })
  clock.play()
  f.advance(10)
  f.s.wall += 30
  assert.equal(clock.resync(), 30)
  assert.equal(clock.time, 20)
  assert.equal(clock.ended, true)
  assert.equal(clock.playing, false)
  assert.deepEqual(names(), ['play', 'seek'])
  clock.tick()
  assert.deepEqual(names(), ['play', 'seek', 'ended'])
  f.s.wall += 30
  assert.equal(clock.resync(), 0, 'ended: nothing to resync')
})

test('tick resyncs after more than 1 s of now() since the previous tick', () => {
  const { f, clock, events } = setup()
  clock.play()
  clock.tick()
  f.advance(0.5)
  f.s.wall += 10
  clock.tick()
  assert.equal(clock.time, 0.5, '≤ 1 s since the last tick: no resync')
  f.s.now += 2
  f.s.wall += 2
  const t = clock.tick()
  assert.equal(events.at(-1)[1].reason, 'resync')
  assert.ok(near(t, 12.5), `got ${t}`)
})

test('tick returns time and auto-ends; no events while running normally', () => {
  const { f, clock, names } = setup({ duration: 5 })
  clock.play()
  for (let i = 0; i < 100; i++) {
    f.advance(1 / 60)
    assert.ok(near(clock.tick(), (i + 1) / 60))
  }
  assert.deepEqual(names(), ['play'])
  f.advance(10)
  assert.equal(clock.tick(), 5)
  assert.deepEqual(names(), ['play', 'ended'])
})

test('on: unsubscribe, AbortSignal, already-aborted signal, unknown events', () => {
  const { clock } = setup()
  const got = []
  const off = clock.on('seek', (d) => got.push(d.time))
  clock.seek(1)
  off()
  clock.seek(2)
  assert.deepEqual(got, [1])

  const ac = new AbortController()
  clock.on('seek', (d) => got.push(d.time), { signal: ac.signal })
  clock.seek(3)
  ac.abort()
  clock.seek(4)
  assert.deepEqual(got, [1, 3])

  clock.on('seek', () => got.push('never'), { signal: AbortSignal.abort() })
  clock.seek(5)
  assert.deepEqual(got, [1, 3])

  const noop = clock.on('nope', () => {})
  assert.equal(typeof noop, 'function')
  noop()
})

test('listener errors are caught and console.error-ed; later listeners still run', (t) => {
  const { clock } = setup()
  const logged = []
  t.mock.method(console, 'error', (e) => logged.push(e))
  const order = []
  clock.on('play', () => { throw new Error('boom') })
  clock.on('play', () => order.push('second'))
  clock.play()
  assert.equal(logged.length, 1)
  assert.equal(logged[0].message, 'boom')
  assert.deepEqual(order, ['second'])
  assert.equal(clock.playing, true)
})

test('a listener can unsubscribe itself while being called', () => {
  const { clock } = setup()
  const calls = []
  const off = clock.on('seek', () => { calls.push('a'); off() })
  clock.on('seek', () => calls.push('b'))
  clock.seek(1)
  clock.seek(2)
  assert.deepEqual(calls, ['a', 'b', 'b'])
})

test('snapshot / restore: playing adds elapsed wall time × rate; paused restores as-is', () => {
  const { f, clock } = setup({ duration: 200 })
  clock.play()
  f.advance(10)
  clock.setRate(1.2)
  f.advance(10)
  const snap = clock.snapshot()
  assert.deepEqual(snap, { time: 22, playing: true, rate: 1.2, wallMs: f.s.wall * 1000 })

  const g = fake({ now: 5, wall: f.s.wall + 5 })
  const restored = Clock.restore(snap, { now: g.now, wallNow: g.wallNow, duration: 200 })
  assert.ok(near(restored.time, 28))
  assert.equal(restored.playing, true)
  assert.equal(restored.rate, 1.2)
  assert.equal(restored.duration, 200)
  g.advance(1)
  assert.ok(near(restored.time, 29.2))

  clock.pause()
  const paused = Clock.restore(clock.snapshot(), { now: g.now, wallNow: () => g.s.wall + 1000, duration: 200 })
  assert.equal(paused.time, 22)
  assert.equal(paused.playing, false)
})

test('restore clamps to duration and only plays when time < duration; emits nothing', () => {
  const f = fake()
  const snap = { time: 50, playing: true, rate: 1, wallMs: (f.s.wall - 30) * 1000 }
  const c = Clock.restore(snap, { now: f.now, wallNow: f.wallNow, duration: 60 })
  assert.equal(c.time, 60)
  assert.equal(c.playing, false)
  assert.equal(c.ended, true)
  const events = []
  c.on('ended', () => events.push('ended'))
  c.tick()
  assert.deepEqual(events, [], 'restored already stopped: no ended event')

  const ok = Clock.restore({ time: 10, playing: true, rate: 1, wallMs: f.s.wall * 1000 }, { now: f.now, wallNow: f.wallNow })
  assert.equal(ok.playing, true)
  assert.equal(ok.duration, Infinity)
})

test('restore tolerates junk snapshots', () => {
  const f = fake()
  for (const junk of [null, undefined, {}, { time: 'x', rate: NaN, playing: 'yes', wallMs: 'later' }, { time: -5 }]) {
    const c = Clock.restore(junk, { now: f.now, wallNow: f.wallNow, duration: 100 })
    assert.ok(c.time >= 0 && c.time <= 100)
    assert.equal(c.rate, 1)
  }
})

test('deterministic under fake time: same script → same events and times (property)', () => {
  const run = (seed) => {
    const rnd = mulberry32(seed)
    const { f, clock, events } = setup({ duration: 30 + Math.floor(rnd() * 100) })
    const trace = []
    for (let i = 0; i < 400; i++) {
      const r = rnd()
      if (r < 0.15) clock.play()
      else if (r < 0.25) clock.pause()
      else if (r < 0.32) clock.seek(rnd() * 150 - 10, 'cue')
      else if (r < 0.38) clock.nudge((rnd() - 0.5) * 4)
      else if (r < 0.43) clock.setRate(0.4 + rnd() * 1.2)
      else if (r < 0.46) clock.duration = 20 + rnd() * 120
      else if (r < 0.5) { f.s.wall += rnd() * 40 - 5; clock.resync() }
      else if (r < 0.52) clock.toggle()
      else { f.advance(rnd() * 2); clock.tick() }
      trace.push([clock.time, clock.playing, clock.ended, clock.rate])
    }
    return { trace, events }
  }
  for (let seed = 1; seed <= 40; seed++) assert.deepEqual(run(seed), run(seed))
})

test('invariants under random operations (property)', () => {
  for (let seed = 100; seed < 160; seed++) {
    const rnd = mulberry32(seed)
    const { f, clock, events } = setup({ duration: 40 + rnd() * 60 })
    let lastLen = 0
    for (let i = 0; i < 500; i++) {
      const before = { time: clock.time, playing: clock.playing }
      const r = rnd()
      let kind = 'advance'
      if (r < 0.12) { kind = 'play'; clock.play() }
      else if (r < 0.2) { kind = 'pause'; clock.pause() }
      else if (r < 0.26) { kind = 'seek'; clock.seek(rnd() * 120 - 10) }
      else if (r < 0.3) { kind = 'rate'; clock.setRate(0.4 + rnd() * 1.2) }
      else if (r < 0.33) { kind = 'resync'; f.s.wall += rnd() * 10 - 5; clock.resync() }
      else { f.advance(rnd() * 3) }
      const t = clock.time
      assert.ok(t >= 0 && t <= clock.duration, 'time within [0, duration]')
      assert.equal(clock.ended, t >= clock.duration)
      assert.ok(!(clock.playing && clock.ended))
      if (kind === 'advance') {
        if (before.playing) assert.ok(t >= before.time - 1e-9, 'monotonic while playing')
        else assert.equal(t, before.time, 'paused time stands still')
        assert.equal(events.length, lastLen, 'getters and time passing emit nothing')
      }
      if (kind === 'resync') assert.ok(t >= before.time - 1e-9, 'resync never moves time backwards')
      if (kind === 'rate') assert.ok(near(t, before.time), 'setRate never moves time')
      lastLen = events.length
    }
    let playing = false
    for (const [e] of events) {
      if (e === 'play') { assert.equal(playing, false); playing = true }
      if (e === 'pause' || e === 'ended') { assert.equal(playing, true, `${e} only from a running clock`); playing = false }
    }
  }
})
