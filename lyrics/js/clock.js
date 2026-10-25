// Song clock with injectable time sources. Runs in song seconds; getters are pure.

import { clamp } from './format.js'

const EVENTS = ['play', 'pause', 'seek', 'rate', 'ended']
const MAX_DRIFT = 21600

const validDuration = (d) => typeof d === 'number' && d > 0

/**
 * A playback clock. Time = anchorTime + (now() - anchorNow) · rate while playing, clamped to
 * [0, duration]. Every state change re-anchors. Reaching the end is detected lazily: getters
 * report it at once, and the next tick() or mutator stops the clock and emits 'ended' once.
 */
export class Clock {
  /**
   * @param {{ now?: () => number, wallNow?: () => number, duration?: number }} [opts]
   *   now: monotonic seconds; wallNow: wall-clock seconds (used to detect suspensions)
   */
  constructor({ now = () => performance.now() / 1000, wallNow = () => Date.now() / 1000, duration = Infinity } = {}) {
    this._now = now
    this._wallNow = wallNow
    this._duration = validDuration(duration) ? duration : Infinity
    this._rate = 1
    this._playing = false
    this._anchorTime = 0
    this._anchorNow = now()
    this._anchorWall = wallNow()
    this._lastTick = this._anchorNow
    this._listeners = new Map(EVENTS.map((e) => [e, new Set()]))
  }

  /** Current song time in seconds (pure). */
  get time() {
    return this._timeAt(this._now())
  }

  /** True once time has reached a finite duration (pure). */
  get ended() {
    return Number.isFinite(this._duration) && this.time >= this._duration
  }

  /** True while running and not yet at the end (pure). */
  get playing() {
    return this._playing && !this.ended
  }

  get rate() {
    return this._rate
  }

  get duration() {
    return this._duration
  }

  /** Ignored unless d > 0 (Infinity allowed). Lowering it below the paused time moves time down. */
  set duration(d) {
    this._autoEnd()
    if (!validDuration(d)) return
    this._anchor()
    this._duration = d
    this._anchorTime = Math.min(this._anchorTime, d)
  }

  /** Starts the clock. No-op if already playing or at the end (restart with seek(0) first). */
  play() {
    this._autoEnd()
    if (this._playing || this.ended) return
    this._anchor()
    this._playing = true
    this._emit('play', { time: this._anchorTime })
  }

  /** Stops the clock. No-op if not playing. */
  pause() {
    this._autoEnd()
    if (!this._playing) return
    this._anchor()
    this._playing = false
    this._emit('pause', { time: this._anchorTime })
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  /**
   * Jumps to t (clamped to [0, duration]); keeps playing/paused. Emits 'seek' { time, reason }, and
   * 'ended' after it when a playing clock is seeked to the end.
   * @param {number} t
   * @param {string} [reason]
   */
  seek(t, reason = 'user') {
    this._autoEnd()
    if (typeof t !== 'number' || !Number.isFinite(t)) return
    const time = clamp(t, 0, this._duration)
    this._setAnchor(time)
    this._emit('seek', { time, reason })
    if (this._playing && time >= this._duration) {
      this._playing = false
      this._emit('ended', { time })
    }
  }

  /** seek(time + dt, 'nudge') */
  nudge(dt) {
    this._autoEnd()
    this.seek(this.time + dt, 'nudge')
  }

  /** Changes the tempo (clamped 0.5..1.5) without moving time. Emits 'rate' only if it changed. */
  setRate(r) {
    this._autoEnd()
    if (typeof r !== 'number' || !Number.isFinite(r)) return
    this._anchor()
    const next = clamp(r, 0.5, 1.5)
    if (next === this._rate) return
    this._rate = next
    this._emit('rate', { rate: next, time: this._anchorTime })
  }

  /** pause(), then seek(0, 'reset'). */
  reset() {
    this.pause()
    this.seek(0, 'reset')
  }

  /**
   * Catches up after a suspension in which the monotonic clock stood still but the wall clock ran.
   * Only while playing, and only forwards (0.25 s < drift < 6 h).
   * @returns {number} the drift applied in seconds, or 0
   */
  resync() {
    if (!this.playing) return 0
    const n = this._now()
    const w = this._wallNow()
    const drift = (w - this._anchorWall) - (n - this._anchorNow)
    if (!(drift > 0.25 && drift < MAX_DRIFT)) return 0
    const time = clamp(this._timeAt(n) + drift * this._rate, 0, this._duration)
    this._anchorTime = time
    this._anchorNow = n
    this._anchorWall = w
    this._emit('seek', { time, reason: 'resync' })
    return drift
  }

  /** Per-frame update: resync after a > 1 s gap between ticks, then the auto-end check. Returns time. */
  tick() {
    const n = this._now()
    if (n - this._lastTick > 1) this.resync()
    this._lastTick = n
    this._autoEnd()
    return this.time
  }

  /**
   * Subscribes to 'play' | 'pause' | 'seek' | 'rate' | 'ended'. Aborting `signal` unsubscribes.
   * @returns {() => void} unsubscribe
   */
  on(event, fn, { signal } = {}) {
    const set = this._listeners.get(event)
    if (!set || typeof fn !== 'function' || signal?.aborted) return () => {}
    const entry = { fn }
    set.add(entry)
    const off = () => {
      set.delete(entry)
      signal?.removeEventListener?.('abort', off)
    }
    signal?.addEventListener?.('abort', off, { once: true })
    return off
  }

  /** @returns {{ time: number, playing: boolean, rate: number, wallMs: number }} */
  snapshot() {
    return { time: this.time, playing: this.playing, rate: this._rate, wallMs: this._wallNow() * 1000 }
  }

  /**
   * Rebuilds a clock from snapshot(), adding the wall time elapsed since it was taken when it was
   * playing. No events are emitted.
   * @returns {Clock}
   */
  static restore(snap, { now, wallNow, duration } = {}) {
    const clock = new Clock({ now, wallNow, duration })
    const s = snap && typeof snap === 'object' ? snap : {}
    const rate = typeof s.rate === 'number' && Number.isFinite(s.rate) ? clamp(s.rate, 0.5, 1.5) : 1
    let time = typeof s.time === 'number' && Number.isFinite(s.time) ? s.time : 0
    if (s.playing && typeof s.wallMs === 'number' && Number.isFinite(s.wallMs)) {
      time += Math.max(0, (clock._wallNow() * 1000 - s.wallMs) / 1000) * rate
    }
    clock._rate = rate
    clock._setAnchor(clamp(time, 0, clock._duration))
    clock._playing = !!s.playing && clock._anchorTime < clock._duration
    return clock
  }

  _timeAt(n) {
    const t = this._playing ? this._anchorTime + (n - this._anchorNow) * this._rate : this._anchorTime
    return clamp(t, 0, this._duration)
  }

  _setAnchor(time) {
    this._anchorTime = time
    this._anchorNow = this._now()
    this._anchorWall = this._wallNow()
  }

  _anchor() {
    const n = this._now()
    this._anchorTime = this._timeAt(n)
    this._anchorNow = n
    this._anchorWall = this._wallNow()
  }

  /** Stops a playing clock that has reached the end and emits 'ended' (once per run). */
  _autoEnd() {
    if (!this._playing) return
    const n = this._now()
    if (this._timeAt(n) < this._duration) return
    this._anchorTime = this._duration
    this._anchorNow = n
    this._anchorWall = this._wallNow()
    this._playing = false
    this._emit('ended', { time: this._duration })
  }

  _emit(event, detail) {
    for (const { fn } of [...this._listeners.get(event)]) {
      try {
        fn(detail)
      } catch (err) {
        console.error(err)
      }
    }
  }
}
