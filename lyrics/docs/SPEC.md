# StageLyrics — spec and module contracts (v1)

StageLyrics is a lyrics prompter for vocalists performing live. You add a song,
the app finds its lyrics and duration online, and the lyrics scroll in time with
the music. The text is large, and most of the screen shows what's coming up.

This is the v1 contract. Every module below has a fixed public API so modules
can be built and tested independently. **If you change a signature, update this
file in the same change.**

## Goals for v1

1. **Add a song.** Type the title and artist. The app searches LRCLIB, lists
   the matches (marking which ones have synced timing), and you pick one. If
   there's no match, paste lyrics (plain or LRC) and type the duration.
2. **Timing.**
   - *Synced* LRC (`[mm:ss.xx] line`) is used as-is.
   - *Plain* lyrics get estimated times spread across the duration, weighted
     by syllables, with an intro lead-in, an outro, and gaps between verses.
   - *Tap-to-sync*: play the track and tap on each line to record real
     timestamps.
   - A per-song offset and tempo rate cover live arrangements that drift from
     the recording.
3. **Perform.**
   - Huge, high-contrast text. The current line sits about 30% down the
     screen, so most of the view is upcoming lyrics.
   - Smooth line-by-line scrolling.
   - Countdowns for the intro and instrumental breaks.
   - Three modes per song:
     - **Track**: the clock runs freely, for backing tracks.
     - **Band**: the clock runs but holds at intros and breaks until the
       singer cues back in.
     - **Manual**: the pedal steps through lines.
   - Foot pedals and keyboards work (Bluetooth page turners send key
     presses). A pedal press means "this line is starting now", which
     corrects drift.
   - The screen stays awake, and nothing ever interrupts the performer.
4. **Library.**
   - Every added song is stored on the device (IndexedDB) and works offline.
   - It opens instantly and filters as you type.
   - Sort by recent, title, or artist, with an A–Z jump rail.
   - Export and import as JSON.
5. **Offline-first PWA.** A service worker caches the app shell. Only adding a
   song via search needs the network.

Out of scope for v1 (planned next): setlists, listening to the band's audio
for automatic sync, cloud sync between devices, word-level karaoke, and
learning timing from the cues recorded during a performance.

## Hard rules

- **No copyrighted lyrics in the repo.** Demo songs, fixtures, test data, docs,
  and commit messages use ORIGINAL placeholder lines written for this project
  (see `js/demo.js`, `tests/fixtures/`). Never paste or quote real song lyrics.
  Lyrics only enter the app at runtime, from LRCLIB or from what the user
  pastes.
- **Never interrupt the performer.** While the perform or sync view is
  mounted, nothing appears that the user didn't start: no toasts, dialogs,
  `confirm()`, banners, permission prompts, or route changes. `ctx.toast()`
  calls are queued and shown after leaving perform/sync. Background writes
  (markPlayed, offset/rate/mode saves) fail silently and retry once. The
  service worker never activates a new version on its own, and the page
  never reloads itself.
- Vanilla ES modules with no build step and no runtime dependencies. It must
  run from any static server and from GitHub Pages under a sub-path
  (`/jarvis-hud/lyrics/`), so **every URL is relative** (`./sw.js`,
  `js/main.js`, `icons/…`).
- Pure modules (`format.js`, `lrc.js`, `timing.js`, `clock.js`, `song.js`,
  `lrclib.js`, `demo.js`) must not touch `document` or `window` at import or
  call time, apart from guarded optional reads such as
  `globalThis.navigator?.onLine`. Node must be able to import and unit-test
  them. `lrclib.js` takes an injectable `fetch`. `clock.js` takes injectable
  `now()` and `wallNow()`.
- Use the system font stack (no web fonts), because the app has to render
  offline at a venue.
- Targets: current iPadOS/iOS Safari (tab and Home Screen app), Chrome
  (Android and desktop), and Firefox. Touch targets are at least 48px.
- Debug instrumentation: when the URL has `?debug`, `window.__sl = { rafLoops, liveViews, session }`
  is kept up to date. rafLoops is the number of running rAF loops and
  liveViews is the number of views mounted and not yet destroyed. E2E tests
  use it.

## File layout and ownership

```
lyrics/
  index.html               app shell (owner: shell)
  manifest.webmanifest     (shell)
  sw.js                    service worker (shell)
  icons/                   done
  css/app.css              tokens, base, shared components: buttons, toggles, sheet, toast, banner (shell)
  css/perform.css          perform + sync lyric column, overlay, control bars (perform)
  css/views.css            library, add, edit, settings (views)
  js/
    main.js                bootstrap, navigation, global keys, session, toasts queue (views)
    router.js              hash router (shell)
    platform.js            capability detection, fullscreen, wake lock (shell)
    format.js              (core)        lrc.js (core)        timing.js (core)       clock.js (core)
    song.js                (data)        store.js (data)      lrclib.js (net)        demo.js (done)
    ui/dom.js              h(), icon(), toast host, confirm sheet, debounce (shell)
    ui/lyric-column.js     shared lyric column renderer for perform + sync (perform)
    ui/perform-view.js     (perform)     ui/sync-view.js (perform)
    ui/library-view.js     (views)       ui/add-view.js (views)
    ui/edit-view.js        (views)       ui/settings-view.js (views)
  tools/serve.mjs          static server (done)
  tools/stamp-sw.mjs       rewrites VERSION + ASSETS in sw.js (shell)
  tests/unit/*.test.js     node:test + node:assert/strict
  tests/e2e/run.mjs        Playwright end-to-end tests
  tests/fixtures/          original fake lyrics + fake LRCLIB JSON (done)
  package.json             scripts: test, test:unit, test:e2e, serve, sw:stamp
  README.md
```

## Data model

```js
/** @typedef {{ t: number, text: string, section?: string }} Line
 *  t       start time in seconds (song time, before the per-song offset)
 *  text    the displayed line. '' (empty string) is a GAP MARKER: an
 *          instrumental break or stanza gap. It renders as a fixed-height "♪"
 *          spacer and never counts as a sung line.
 *  section optional label shown above this line ("Chorus", "Verse 2").
 */

/** @typedef {{
 *   id: string,                 // [A-Za-z0-9_-]{1,64}; newId()
 *   title: string,              // non-empty, ≤ 300 chars
 *   artist: string,             // may be ''
 *   album: string,              // may be ''
 *   duration: number,           // seconds, 0 < duration ≤ 21600 (default 210 when unknown)
 *   timing: 'synced'|'estimated'|'tapped',
 *   lines: Line[],              // sorted by t ascending (stable), 0 ≤ t ≤ duration, ≤ 5000 entries
 *   source: { provider: 'lrclib'|'manual'|'demo', lrclibId?: number },
 *   rawPlain: string,           // plain lyrics text (no timestamps), kept for re-estimation
 *   rawSynced: string,          // original LRC text if any, else ''
 *   estimate: { leadIn: number|null, outro: number|null }, // null = automatic defaults
 *   offset: number,             // seconds, -30..30; positive = lyrics appear LATER
 *   rate: number,               // tempo multiplier for live performance, 0.5..1.5, default 1
 *   mode: 'track'|'band'|'manual', // perform mode this song opens in, default 'track'
 *   instrumental: boolean,
 *   createdAt: number, updatedAt: number, lastPlayedAt: number, playCount: number,  // ms epoch; 0 = never
 *   schema: 1,
 *   readOnly?: true             // set by normalizeSong when schema > SCHEMA (record from a newer app)
 * }} Song */
```

**Display time** of line `i`: `D(i) = lines[i].t + song.offset`. The clock always
runs in **song time** (0 = start of the recording). Offset is applied only
when comparing against display times, so nudging the offset never moves the
clock.

**Sung line**: `lines[i].text !== ''`.

## Module contracts

### `js/format.js` (pure)
```js
export function clamp(x, lo, hi)           // NaN → lo
export function formatTime(sec)            // → "m:ss" (75.4 → "1:15", floors seconds); <0/NaN → "0:00"; ≥ 3600 → "h:mm:ss"
export function formatOffset(sec)          // 0.5 → "+0.5s", -1 → "−1.0s", 0 → "0.0s" (U+2212 minus)
export function parseTime(str)             // "3:25" | "03:25" | "205" | "3:25.5" | "1:02:03" | " 3:05 " → seconds | null
                                           // invalid: "", "abc", "3:75", "-1", "1:2:3:4" → null
export function normalizeForMatch(str)     // lowercase; strip diacritics (NFD + remove \p{M}); drop "(feat. …)", "[…]",
                                           // " - Remastered …", " - Live …", " - Radio Edit"; '&' → 'and';
                                           // collapse non-[a-z0-9] to single spaces; trim
export function escapeHtml(str)
```

### `js/lrc.js` (pure)
```js
export function isLrc(text)                // true iff ≥ 1 line matches /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/
export function parseLrc(text)
  // → { lines: Line[], meta: { ti?: string, ar?: string, al?: string, length?: number, offsetMs?: number } }
  // Timestamp forms: [m:ss] [mm:ss] [mmm:ss] with optional fraction [.x] [.xx] [.xxx] or [:xx].
  //   The fraction is a DECIMAL fraction of a second: ".5" = 0.5s, ".50" = 0.5s, ".500" = 0.5s, ".05" = 0.05s.
  //   A ':xx' fraction is centiseconds (":30" = 0.30s). Seconds ≥ 60 → the tag is invalid and ignored.
  // Several tags on one line ("[00:12.00][01:30.00]text") → one Line per tag with the same text.
  // Metadata tags (case-insensitive key): ti ar al au by re ve length offset. [length: 3:25] → parseTime.
  //   [offset:+250] / [offset:-250] → meta.offsetMs. Convention (LRC standard): a POSITIVE offset makes
  //   lyrics appear EARLIER, so every t = t - offsetMs/1000. Applied at parse time; serializeLrc never
  //   writes an offset tag.
  // Text: strip word-level tags /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, then trim, then collapse internal whitespace runs to one space.
  // Timed lines with empty text → '' gap markers. Untimed non-metadata lines are ignored.
  // CRLF/CR line endings and a leading BOM (U+FEFF) are handled.
  // Output: sorted by t ascending, STABLE (equal t keep source order); t clamped to ≥ 0 (after offset);
  //   gap markers dropped if first in the list; consecutive gap markers collapsed to the first;
  //   a gap marker with the same t as the following sung line is dropped.
export function serializeLrc(lines)        // Line[] → "[mm:ss.xx]text\n"…; minutes zero-padded to ≥ 2 digits; centiseconds
                                           // ROUNDED (59.996 → "01:00.00", carrying into minutes). Sections are not representable and
                                           // are dropped. Round-trip: parseLrc(serializeLrc(x)).lines matches x within 0.005s (minus sections,
                                           // minus normalizations above).
export function parsePlain(text)
  // → Array<{ text: string, section?: string }> (no times)
  // - CRLF/BOM handled; each line trimmed; internal whitespace collapsed.
  // - A run of ≥ 1 blank lines between lyric lines → ONE '' gap marker. Leading/trailing gaps are removed.
  // - SECTION HEADERS are not lyric lines. A header is a line that matches entirely (case-insensitive):
  //     [Label] or (Label) or {Label}   where Label starts with a known section word, e.g. "[Chorus: Name]", "(Verse 2)"
  //     Label:                          (a known section word + optional number + colon, nothing after the colon)
  //     Label                           (a bare known section word + optional number, e.g. "Bridge", "Verse 2")
  //   Known words: intro, verse, pre-chorus, prechorus, chorus, post-chorus, hook, refrain, bridge, breakdown,
  //     interlude, instrumental, solo, outro, tag, coda. The label kept is the word (title-cased) plus number:
  //     "[Chorus: Name]" → "Chorus", "verse 2:" → "Verse 2", "PRE-CHORUS" → "Pre-Chorus".
  //   The label goes on the next lyric line as `section`. If the header is not the first item and the
  //   previous item is not already a gap marker, a gap marker is inserted before that line.
  //   Headers with no lyric line after them are dropped.
  // - A line in square brackets that is NOT a known section (e.g. "[Spoken softly]") is kept as a lyric line.
  // - Timestamped lines are never headers.
export function lyricsToEditableText(song) // timing 'synced'|'tapped' → serializeLrc(song.lines); 'estimated' → song.rawPlain
```

### `js/timing.js` (pure)
Notation: `D(i) = lines[i].t + offset`; "sung" means `text !== ''`.
```js
export function countSyllables(text)       // ≥ 1 for any non-empty text with at least one letter/number; 0 for '' or symbols-only.
                                           // Heuristic per word: vowel groups [aeiouy]+ (after NFD + lowercase), minus a silent final
                                           // 'e' (but not "-le" after a consonant), min 1 per word; digits count 1 per digit group;
                                           // non-Latin letters: 1 per 2 letters (rounded up). Never throws.
export function estLineSeconds(text)       // clamp(countSyllables(text) * 0.32, 1.5, 6); '' → 0
export function estimateTimings(plainLines, duration, opts = {})
  // plainLines: Array<{text, section?}>; opts: { leadIn?: number|null, outro?: number|null, gapWeight?: number }
  // leadIn  = opts.leadIn ?? clamp(duration*0.07, 4, 20);  outro = opts.outro ?? clamp(duration*0.06, 3, 20)
  // both clamped ≥ 0; if leadIn + outro > duration*0.8 they are scaled by (duration*0.8)/(leadIn+outro).
  // window = duration - leadIn - outro (> 0 by the above).
  // weight(sung) = max(3, countSyllables(text)); weight(gap) = gapWeight ?? mean sung weight (3 if none).
  // t[i] = leadIn + window * (sum of weights before i) / totalWeight   → monotonic non-decreasing, t[0] = leadIn,
  //   the last line starts before duration - outro. Same length/order as input; sections preserved.
  // Empty input → []. duration ≤ 0 or non-finite → treated as 210.
export function activeLineIndex(lines, time, offset = 0)
  // largest i with D(i) <= time, or -1. Binary search. With equal t values, returns the LAST of the run.
export function nextSungIndex(lines, i)    // smallest j > i with lines[j] sung, else -1  (i may be -1)
export function prevSungIndex(lines, i)    // largest j < i with lines[j] sung, else -1
export function firstSungIndex(lines)      // nextSungIndex(lines, -1)
export function lastSungIndex(lines)
export function sungAtOrBefore(lines, i)   // i if lines[i] sung, else prevSungIndex(lines, i); -1 if none (i = -1 → -1)
export function lineEnd(lines, c, offset)
  // estimated end of sung line c: min(D(c) + estLineSeconds(text_c), D(k)) where k is the first index > c that is
  // either a gap marker or a sung line (i.e. simply the next line of any kind); if no next line, D(c) + estLineSeconds.
export function lineProgress(lines, i, time, offset, duration)
  // i < 0 → 0. Otherwise (time - D(i)) / (E - D(i)), clamped 0..1, where E = D(next line of any kind) or duration;
  // if E <= D(i) → 1.
export function gapInfo(lines, time, offset, duration, threshold = 6)
  // → null | { kind: 'intro'|'break'|'outro', secondsUntilNext, nextIndex, progress }   (progress 0..1)
  // f = firstSungIndex(lines); if f === -1 → null.
  // INTRO: time < D(f): if D(f) >= threshold → { 'intro', D(f) - time, f, clamp(time / D(f), 0, 1) } else null.
  // Otherwise c = sungAtOrBefore(lines, activeLineIndex(lines, time, offset)); n = nextSungIndex(lines, c); e = lineEnd(lines, c, offset).
  // OUTRO: n === -1 and time >= e → { 'outro', max(0, duration - time), -1, duration > e ? clamp((time-e)/(duration-e),0,1) : 1 }.
  // BREAK: n !== -1 and (D(n) - e) >= threshold and time >= e → { 'break', D(n) - time, n, clamp((time - e)/(D(n) - e), 0, 1) }.
  // Else null.
export function holdPoint(lines, time, offset, duration, { threshold = 6, lead = 0.45 } = {})
  // Band mode. g = gapInfo(lines, time, offset, duration, threshold); g null or 'outro' → null;
  // else max(time, D(g.nextIndex) - lead) — i.e. where the clock must stop and wait for the singer's cue.
  // (Clamped to time when that point has already passed, as happens for breaks shorter than `lead`.)
export function cueIndex(lines, time, offset, dir, { snap = 1.2 } = {})
  // Pedal semantics, "the line I mean is starting NOW". dir 'next' | 'prev'. Returns a line index or -1 (no-op).
  // f = firstSungIndex; f === -1 → -1.
  // Before the first line (time < D(f)): next → f; prev → -1.
  // Else c = sungAtOrBefore(lines, activeLineIndex(lines, time, offset)); n = nextSungIndex(lines, c).
  //  next: s = n === -1 ? snap : min(snap, 0.5 * (D(n) - D(c)));  time - D(c) < s → c  (confirm a line that just lit up)
  //        else → n (may be -1: nothing after the last line).
  //  prev: p = prevSungIndex(lines, c); → p !== -1 ? p : c.
export function shiftLines(lines, delta, duration) // new array, every t += delta, clamped to [0, duration]; order kept (stable sort after clamp)
export function validateLines(lines, duration)     // new sorted (stable) array: drops entries with non-finite t or non-string text,
                                                   // clamps t to [0, duration], truncates text to 1000 chars, caps at 5000 lines. Never throws.
```

### `js/clock.js` (pure)
```js
export class Clock {
  constructor({ now = () => performance.now() / 1000, wallNow = () => Date.now() / 1000, duration = Infinity } = {})
  get time()          // song time in seconds, clamped to [0, duration]. While playing: anchorTime + (now() - anchorNow) * rate.
                      // Reading time checks for the end: if it reaches duration while playing, the clock stops
                      // (playing = false, time = duration) and 'ended' fires once.
  get playing()       // boolean
  get rate()
  get duration()      // set duration(d): d > 0 finite or Infinity; re-anchors; clamps time
  get ended()         // time >= duration (duration finite)
  play()              // no-op if playing or ended (Restart is explicit: seek(0) then play()). Re-anchors; emits 'play'.
  pause()             // no-op if paused. Freezes time; emits 'pause'.
  toggle()
  seek(t, reason = 'user') // clamps to [0, duration]; keeps play state; re-anchors; clears ended (if t < duration);
                      // emits 'seek' with { time, reason }. Seeking to ≥ duration while playing → stops and fires 'ended'.
  nudge(dt)           // seek(time + dt, 'nudge')
  setRate(r)          // clamps to [0.5, 1.5]; time continues without a jump (re-anchor first); emits 'rate'
  reset()             // pause(); seek(0, 'reset')
  resync()            // Corrects suspension drift: while playing,
                      //   drift = (wallNow() - anchorWall) - (now() - anchorNow)
                      //   if 0.25 < drift < 21600: anchorTime += drift * rate, re-anchor, emit 'seek' { reason: 'resync' }, return drift.
                      // Otherwise (paused, drift ≤ 0.25 or negative/absurd) → 0. Never moves time backwards.
  tick()              // call once per animation frame. If more than 1 s of now() passed since the previous tick, call resync() first.
                      // Returns `time` (and so may fire 'ended').
  on(event, fn, { signal } = {}) → unsubscribe   // events: 'play','pause','seek','rate','ended'.
                      // Listener errors are caught and reported with console.error, so they don't break the clock.
  snapshot()          // → { time, playing, rate, wallMs: wallNow()*1000 } for the live-session record
  static restore(snap, opts) // → Clock with time = snap.playing ? snap.time + (wallNow()*1000 - snap.wallMs)/1000 * snap.rate : snap.time
                      // (clamped), same rate, playing iff snap.playing && time < duration
}
```
Every re-anchor records anchorTime, anchorNow = now(), and anchorWall = wallNow().

### `js/song.js` (pure)
```js
export const SCHEMA = 1
export const DEFAULT_DURATION = 210
export const LIMITS = { title: 300, lineText: 1000, lines: 5000, duration: 21600 }
export function newId()                    // crypto.randomUUID() if available, else 32 hex chars from crypto.getRandomValues;
                                           // Math.random only if neither exists (Node < 19 fallback)
export function songFromLrclib(cand, now = Date.now())
  // cand: Candidate (see lrclib.js). If cand.syncedLyrics is non-empty → timing 'synced', lines = parseLrc(...).lines.
  // Else if plainLyrics → 'estimated' via estimateTimings. Instrumental or no lyrics → lines [], instrumental true.
  // duration = cand.duration > 0 ? cand.duration : (synced ? last t + 5 : DEFAULT_DURATION); any line t > duration
  // extends duration to that t + 5 (LRCLIB durations can be wrong).
  // source { provider:'lrclib', lrclibId }, rawPlain = plainLyrics || derived from synced lines (texts joined, '' → blank line),
  // rawSynced = syncedLyrics || '', mode 'track'.
export function songFromText({ title, artist = '', album = '', text, duration }, now = Date.now())
  // isLrc(text) → 'synced' (duration falsy → max(meta.length || 0, last t + 5)); else plain → 'estimated'
  // (duration falsy → DEFAULT_DURATION). source { provider:'manual' }. Title '' → 'Untitled'.
export function songFromDemo(now = Date.now())  // from js/demo.js; id DEMO_ID, provider 'demo', timing 'synced'
export function updateSongText(song, text, now = Date.now())
  // Re-parses edited lyric text. LRC → lines from parseLrc; timing stays 'tapped' if it was 'tapped', else 'synced';
  // rawSynced = text; rawPlain derived. Plain → 'estimated' with song.estimate; rawPlain = text. Duration grows to fit (last t + 5).
  // Returns a NEW song (inputs are never mutated); updatedAt = now.
export function retime(song, { duration, leadIn, outro } = {}, now = Date.now())
  // Estimated songs: recompute lines from rawPlain with the new estimate. Others: update duration only, clamping lines.
  // leadIn/outro: undefined = keep, null = automatic. Returns a NEW song.
export function applyTappedTimes(song, times, now = Date.now())
  // times: (number|null)[] aligned to song.lines. Result: timing 'tapped', NEW song, lines monotonic non-decreasing.
  // - Tapped entries keep their time; any tap lower than the previous tapped time is raised to it.
  // - Untapped entries between two tapped ones: linear interpolation by index.
  // - Untapped entries before the first tap: placed proportionally (by index) between 0 and the first tap.
  // - Untapped entries after the last tap: spread evenly between lastTap + 2s and max(lastTap + 2, duration - outro),
  //   outro = clamp(duration*0.06, 3, 20); if there is no room they all get lastTap + 2 (+0.5s each, clamped to duration).
  // - No taps at all → song returned unchanged (same object).
  // - duration = max(duration, last time + 1).
export function normalizeSong(obj)
  // Tolerant coercion of partial or old records into a valid Song; never throws. Builds a NEW object from whitelisted
  // fields only (never spreads the input, so no __proto__/junk). Applies MIGRATIONS for schema < SCHEMA.
  // schema > SCHEMA → returns the input's known fields plus readOnly: true (other fields kept as-is).
export function validateSongInput(obj, now = Date.now())
  // For imports: → { ok: true, song } | { ok: false, reason }. Requires a non-empty string title (truncated to 300),
  // lines an array of ≤ 5000 entries each with finite t and string text (truncated to 1000), a finite duration in (0, 21600]
  // (or derivable). An id not matching /^[A-Za-z0-9_-]{1,64}$/ is replaced by newId(). updatedAt is clamped to ≤ now + 86400000.
  // Output goes through normalizeSong.
export function songSummary(song)          // { id, title, artist, duration, timing, mode, sungLines, lastPlayedAt, playCount }
export function sameSong(a, b)             // normalizeForMatch(title) and normalizeForMatch(artist) both equal
```

### `js/lrclib.js` (pure, injectable fetch)
```js
export const LRCLIB_BASE = 'https://lrclib.net'
export class LrclibError extends Error {   // { message, status?: number, kind }
  // kind: 'offline'|'network'|'timeout'|'http'|'parse'|'aborted'|'busy'
}
export function createLrclibClient({ fetch = globalThis.fetch, base = LRCLIB_BASE, timeoutMs = 10000,
    clientName = 'StageLyrics v0.1 (https://github.com/BlackChalice-80/jarvis-hud)', sleep, navigator = globalThis.navigator } = {})
  // → { search(query, { signal }?) : Promise<Candidate[]>   query = { title?, artist?, album?, q? }
  //     get({ title, artist, album?, duration? }, { signal }?) : Promise<Candidate|null>   // 404 → null
  //     getById(id, { signal }?) : Promise<Candidate|null> }                              // 404 → null
  // URLs (URLSearchParams encoding; empty params omitted):
  //   search: title present → /api/search?track_name=…[&artist_name=…][&album_name=…]; else q (or artist) → /api/search?q=…;
  //           nothing → resolves [] without fetching.
  //   get: /api/get?track_name&artist_name[&album_name][&duration=<rounded int>]   getById: /api/get/<id>
  // fetch options: { method:'GET', mode:'cors', credentials:'omit', headers: { 'Lrclib-Client': clientName }, signal }.
  //   No other headers. The server's CORS policy allows Lrclib-Client from any origin.
  // Preflight fallback: if a request WITH the header rejects with a TypeError while navigator?.onLine !== false,
  //   retry it once WITHOUT any custom headers (a simple request needs no preflight) and leave the header off for
  //   the rest of the client's life.
  // navigator?.onLine === false → reject kind 'offline' without fetching. A TypeError while onLine === false → 'offline';
  //   any other TypeError → 'network'.
  // Timeout: per attempt (AbortController). Caller's signal abort → kind 'aborted' (never 'timeout'); an already-aborted
  //   signal rejects immediately.
  // 429 / 503 → retry ONCE after delay = Retry-After (delta-seconds or HTTP-date) clamped to [0.5, 3] s, default 1 s
  //   (in browsers the header is usually unreadable due to CORS). The wait is cancelled by the signal. A second 429/503 → kind 'busy'.
  // Other non-2xx (except 404 on get/getById) → kind 'http' with status. Body not JSON → 'parse'. search with a non-array body → 'parse'.
export function normalizeTrack(raw)
  // LRCLIB JSON → Candidate { lrclibId: number, title, artist, album, duration: number (seconds, 0 if missing),
  //   instrumental: boolean, hasSynced: boolean (syncedLyrics has ≥ 1 timed line), hasPlain: boolean (non-blank plainLyrics),
  //   syncedLyrics: string, plainLyrics: string, sungLines: number (from synced if hasSynced else plain) }
  // API fields: id, name, trackName, artistName, albumName, duration, instrumental, hasWordSync, plainLyrics, syncedLyrics,
  //   lyricsfile (ignored in v1). title = trackName ?? name ?? ''. Null strings → ''. Never throws on junk → returns null
  //   when id is missing.
export function rankCandidates(cands, { title, artist, duration } = {})
  // Drops nulls. Stable sort by: (1) normalized title AND artist equal to the query (when given) first; (2) normalized title equal;
  // (3) hasSynced first; (4) has lyrics (synced or plain) before instrumental/empty; (5) |duration - wanted| ascending when given.
  // Removes duplicates (same normalized title + artist + Math.round(duration) + hasSynced), keeping the first. Returns a new array.
```

### `js/store.js` (browser; IndexedDB with in-memory fallback)
```js
export class StoreError extends Error { /* kind: 'quota'|'unavailable'|'invalid'|'conflict' */ }
export async function openStore({ name = 'stagelyrics', indexedDB = globalThis.indexedDB, openTimeoutMs = 4000, navigator = globalThis.navigator } = {})
  // → Store. DB version 1; onupgradeneeded creates object stores 'songs' (keyPath 'id') and 'meta' (keyPath 'key'), each only if missing.
  // Open is raced against openTimeoutMs. On timeout, error, blocked, or a missing indexedDB → returns the MEMORY store
  // with durability 'memory' and reason 'timeout'|'blocked'|'error'|'unavailable'.
  // db.onversionchange = () => { db.close(); emit('stale') }.
// Store (same API for IDB and memory):
//   durability : 'persisted'|'best-effort'|'memory'   (getter)
//   reason     : string|null
//   on(event, fn) → unsubscribe                       // events: 'stale', 'change' (after any write)
//   listSongs() : Promise<Song[]>                     // normalized; any order
//   getSong(id) : Promise<Song|null>
//   putSong(song) : Promise<Song>                     // normalizeSong, updatedAt = now, write; resolves on tx complete.
//                                                     // readOnly songs → StoreError 'conflict'. QuotaExceededError → StoreError 'quota'.
//                                                     // After the first successful put, calls navigator.storage?.persist?.() once (ignoring errors),
//                                                     // then refreshes durability from navigator.storage.persisted().
//   patchSong(id, patch) : Promise<Song|null>         // read-modify-write in ONE transaction (used for offset/rate/mode/markPlayed)
//   deleteSong(id) : Promise<void>
//   markPlayed(id) : Promise<void>                    // lastPlayedAt = now, playCount + 1
//   exportJson() : Promise<string>                    // JSON.stringify({ app:'stagelyrics', version:1, exportedAt, songs }, null, 2);
//                                                     // records meta.lastExportAt = now
//   importJson(text, { mode = 'merge' }) : Promise<{ added, updated, skipped, errors: Array<{ index, reason }> }>  (errors ≤ 20)
//       1. Before touching the DB, throw StoreError 'invalid' (with a user-facing message) if text.length > 25e6, JSON.parse fails, or the
//          top level is neither { app:'stagelyrics', version, songs: [] } nor a bare array of songs. version > 1 → 'This backup is from a
//          newer StageLyrics. Update the app first.'
//       2. validateSongInput on each entry; invalid → skipped + error.
//       3. All writes in ONE readwrite transaction. merge: same id → keep the one with the greater updatedAt (ties keep existing);
//          replace: clear() inside the same transaction, and only if ≥ 1 entry was valid.
//   clear() : Promise<void>
//   stats() : Promise<{ count, lastExportAt, usage?, quota? }>   // navigator.storage.estimate() when available
//   getMeta(key), setMeta(key, value)
// Every IDB method goes through withDb(op): on InvalidStateError / UnknownError (a lost connection) it reopens once and retries once.
// Each operation uses its own transaction and resolves on tx.oncomplete. No non-IDB awaits inside a transaction.

export function createMemoryStore(reason = 'unavailable') // the in-memory Store (also used by unit tests)
export const DEFAULT_SETTINGS = {
  fontScale: 1,            // 0.6..3, multiplier on the base lyric size
  lineSpacing: 1.2,        // 1.0..2.0
  anchor: 0.3,             // 0.12..0.5, fraction of the perform root height where the current line's top sits
  theme: 'stage',          // 'stage' | 'contrast' | 'daylight'
  mirror: false,           // horizontal flip for teleprompter glass
  uppercase: false,
  showSections: true,
  showCountdown: true,
  gapThreshold: 6,         // seconds, 3..30
  lineProgress: true,
  autoHideControls: true,
  pedalNextStarts: true,
  pedalDebounceMs: 200,    // 0..600
  pedalKeys: { prev: ['ArrowLeft', 'ArrowUp', 'PageUp', 'p', 'P'], next: ['ArrowRight', 'ArrowDown', 'PageDown', 'n', 'N', 'j', 'J'] },
  scrollLead: 0.45,        // seconds; matches the scroll transition length
  holdLead: 0.45,          // seconds before the next line where Band mode holds
  touchLock: false,
  librarySort: 'recent',   // 'recent' | 'title' | 'artist'
  dismissed: {},           // banner id → true
}
export function loadSettings(storage = globalThis.localStorage)  // deep-merges onto DEFAULT_SETTINGS, clamps ranges, drops unknown keys,
                                                                 // tolerates bad JSON or a throwing/missing storage. Key 'stagelyrics.settings'.
export function saveSettings(settings, storage = globalThis.localStorage)  // never throws
export function loadLive(storage), saveLive(record, storage), clearLive(storage)   // key 'stagelyrics.live', never throw
```

### `js/platform.js` (browser; no side effects on import)
```js
export function capabilities()  // { secure, serviceWorker, wakeLock, fullscreen, standalone, ios, iosBrowserTab, persist, share, reducedMotion }
  // fullscreen: !!(document.fullscreenEnabled || document.webkitFullscreenEnabled)
  // standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  // ios: iPhone/iPad/iPod UA or (MacIntel && maxTouchPoints > 1); iosBrowserTab: ios && !standalone
export function requestFullscreen(el), exitFullscreen(), fullscreenElement()   // standard API with webkit-prefixed fallback; never throw (return a Promise)
export function onFullscreenChange(fn, { signal })
export function createWakeLock({ signal })
  // → { get state(): 'held'|'released'|'denied'|'unsupported', request(): Promise<void>, onchange: fn|null }
  // request() is safe to call often (no-op while held). Re-requests on the sentinel's 'release' event and on visibilitychange→visible,
  // but only while !signal.aborted and document.visibilityState === 'visible'. Releases when the signal aborts.
```

### `js/router.js`
```js
export function createRouter(routes, { onNotFound })  // routes: Array<[pattern, handler]>, pattern like '/song/:id/perform'
  // Listens to hashchange. '#/song/abc/perform?x=1' → handler({ path, params: { id: 'abc' }, query: { x: '1' } }).
  // Params are decodeURIComponent-ed. router.go(path, { replace }) sets location.hash (replace → location.replace).
  // router.start() dispatches the current hash (empty → '#/'). router.current → the last route object.
```
Routes:
| hash | view |
|---|---|
| `#/` | library |
| `#/add` | add a song (search, plus manual paste) |
| `#/song/:id/perform` | perform |
| `#/song/:id/edit` | edit lyrics, metadata and timing |
| `#/song/:id/sync` | tap-to-sync recorder |
| `#/settings` | settings, backup, pedal setup, stage check |
| `#/demo` | adds the demo song if it's missing, then `router.go('/song/demo-soundcheck/perform', { replace: true })` |

### Views contract (`js/ui/*-view.js`) and `main.js`
```js
// Each view module: export async function render(ctx, route) → View   (may also return a View synchronously)
// View = { el: HTMLElement, mounted?: () => void, destroy?: () => void, onKey?: (e: KeyboardEvent) => boolean,
//          kind?: 'perform'|'sync'|'page' }
// ctx = { store, settings, saveSettings(patch), router, lrclib, toast(msg, kind?), confirm(msg, { ok, cancel }) → Promise<boolean>,
//         signal: AbortSignal /* fresh per navigation */, session /* see below */, caps /* capabilities() */,
//         swUpdate: { ready: boolean, apply() } }
```
main.js:
- **Loading**: each view module is loaded with a dynamic `import('./ui/<name>-view.js')` on first use and then cached. A failed
  import shows the inline error panel, so one broken view never blanks the app.
- **Navigation**:
  1. `seq = ++navSeq`; call the previous `view.destroy?.()` and abort its controller.
  2. `await render(ctx, route)`.
  3. If `seq !== navSeq`, destroy the stale view and discard it.
  4. Otherwise `#app.replaceChildren(view.el)`, then `view.mounted?.()`, then
     move focus to `view.el` (each view root is a `<section tabindex="-1">`).
  5. Render errors show an inline error panel with a "Back to library" link.
- **Listeners**: views pass `{ signal: ctx.signal }` to every
  `addEventListener` on window, document, visualViewport and media queries,
  to `clock.on`, and to every lrclib call. `destroy()` is idempotent and
  flushes pending debounced saves immediately (fire and forget).
- **Keys**: one `keydown` listener on `window` with `{ capture: true }`.
  Rules, in order:
  1. Ignore events with `e.isComposing`, `e.ctrlKey`, `e.metaKey` or
     `e.altKey`.
  2. If the target is a text-entry control (an input other than
     range/checkbox/radio/button, a textarea, a select, or contenteditable),
     only Escape is passed on.
  3. Call `view.onKey(e)`. If it returns true, call `preventDefault()` and
     `stopPropagation()`, and remember `e.code` so the matching `keyup` is
     swallowed the same way.
- **Toast queue**: `ctx.toast` queues while the current view's
  `kind` is perform or sync, and shows queued toasts after navigating away.
- **Session**: `ctx.session` is the session manager, owned by main.js, so a
  live performance survives navigation:
  ```js
  ctx.session = {
    current,                       // Session | null
    begin(song, { restoreFrom } = {}) → Session  // replaces current. New Clock({ duration: song.duration }) with rate = song.rate,
                                   // mode = song.mode, manualIndex = firstSungIndex, state 'idle', started false, releasedHold null.
                                   // restoreFrom (a live record) → Clock.restore(record), mode/manualIndex/releasedHold from the record,
                                   // started true, state from the clock.
    end(),                         // drops current and calls clearLive()
    save(),                        // writes the live record now
  }
  Session = { songId, clock, mode, manualIndex, state: 'idle'|'playing'|'held'|'ended', releasedHold: number|null, started: boolean }
  ```
  - Perform reuses `session.current` when its songId equals
    `route.params.id`. Otherwise it calls `begin(song)`.
  - Restart calls `begin(song)` again.
  - Perform's `destroy()` calls `end()` when the clock isn't playing, which
    covers paused, held, ended and Manual. A playing session keeps running
    while the user is on other views.
  - main.js subscribes to the current session's clock events
    (play/pause/seek/rate) to write the live record. Perform calls `save()`
    after mode changes and manual steps.
- **Live-session record (crash/reload recovery)**: while a session exists,
  main.js writes `saveLive({ v: 1, songId, mode, manualIndex, releasedHold, ...clock.snapshot() })`:
  - on play, pause, seek, rate change, manual step and mode change;
  - every 5 s while playing;
  - on `visibilitychange`→hidden and on `pagehide`.

  It is cleared when the session is replaced or dropped, on Restart, or when
  the user leaves perform while paused.

  On boot, if the record is less than 20 minutes old and the song exists:
  - **(a)** If the hash is that song's perform route (a reload), restore the
    session with `Clock.restore`.
  - **(b)** Otherwise the library shows a top banner, "Resume ‹title› at
    m:ss", which restores the session the same way and navigates to perform.
- **Service worker**: register only if `'serviceWorker' in navigator && isSecureContext` and the URL has no `?nosw`,
  after `load`: `navigator.serviceWorker.register('./sw.js', { scope: './' })`. Call `registration.update()` when the library
  mounts while online. When `registration.waiting` exists, `ctx.swUpdate.ready = true`. Library and Settings (never perform/sync)
  show "Update ready — Reload". `apply()` posts `{ type: 'SKIP_WAITING' }` and reloads once on `controllerchange`. Nothing else
  reloads the page.

### `js/ui/dom.js` (browser helpers shared by all views)
```js
export function h(tag, props = null, ...children)
  // props: { class: string|string[]|{name: bool}, style: string|object, dataset: object, on: { event: fn | [fn, opts] },
  //          attrs: object (setAttribute), ...anything else assigned as a property (value, checked, type, tabIndex, htmlFor, hidden, disabled…) }
  // children: strings (text nodes, never parsed as HTML), Nodes, arrays (flattened), null/false/undefined (skipped).
export function icon(name, { size = 24, title } = {})   // inline <svg aria-hidden> (stroke=currentColor). Names: play, pause, prev, next,
  // back, gear, plus, more, search, fullscreen, fullscreen-exit, lock, unlock, music, check, x, trash, edit, upload, download, share,
  // sync, minus, restart, list. Unknown name → empty svg.
export function createToastHost(container) // → { show(msg, kind = 'info'|'error'|'ok', ms = 3500) } ; aria-live="polite"
export function confirmSheet(message, { ok = 'OK', cancel = 'Cancel', danger = false, detail } = {}) // → Promise<boolean>; Esc/backdrop = false
export function openSheet({ title, content, onClose })  // bottom sheet with backdrop + close button → { el, close() }; Esc closes
export function debounce(fn, ms)          // → wrapped fn with .flush() (runs pending call now) and .cancel()
export function downloadText(filename, text, mime = 'application/json')  // Blob + <a download>; revokes the URL after 60 s
export function fmtDate(ms)               // → "Oct 25, 2026" (toLocaleDateString), 0 → "never"
```

### Shared CSS vocabulary (`css/app.css`, used by every view)
- **Tokens** (on `:root`, overridden per `[data-stage-theme]`):
  - Colors: `--bg`, `--fg`, `--muted`, `--current`, `--accent`,
    `--accent-fg`, `--surface`, `--surface-2`, `--border`, `--ok`,
    `--info`, `--warn`, `--danger`.
  - Shape and type: `--radius` (12px), `--tap` (48px), `--font-ui`.
  - Lyrics: `--font-scale`, `--line-spacing`, `--anchor`, `--scroll-ms`.

  main.js sets the lyric variables on `<html>` from settings.
- **Classes**:
  - Pages: `.page` (scrollable page root, safe-area padded),
    `.page-inner` (max-width 760px, centered), `.page-header` (sticky
    header row with title and actions).
  - Buttons: `.btn` (48px min height), `.btn-primary`, `.btn-ghost`,
    `.btn-danger`, `.btn-icon` (square 48px), `.btn-lg` (56–64px, larger
    text), `.btn-block`.
  - Segmented control: `.seg`, a `<div class="seg" role="group">` of
    `<button aria-pressed>`.
  - Form fields: `.field`, a `<label class="field"><span class="field-label">…</span><input class="input"></label>`;
    `.input`, `.textarea`, `.range`, `.field-hint`, `.field-error`.
  - Toggle: `.switch`, a `<label class="switch"><input type="checkbox"><span class="switch-track"></span><span>Label</span></label>`.
  - Badges: `.badge` with `.badge-synced` (ok), `.badge-tapped` (info),
    `.badge-estimated` (muted), `.badge-plain` (muted),
    `.badge-instrumental` (warn), `.badge-mode`, `.badge-readonly`.
  - Banners: `.banner` (`.banner-warn`, `.banner-info`), `.banner-text`,
    `.banner-actions`, `.banner-close`.
  - Sheets: `.sheet-backdrop`, `.sheet`, `.sheet-header`, `.sheet-body`.
  - Toasts: `.toast-host`, `.toast` (`.toast-error`, `.toast-ok`).
  - Layout and utilities: `.spinner`, `.empty`, `.muted`, `.row` (flex
    row with gap), `.stack` (flex column with gap), `.grow`,
    `.visually-hidden`, `.card`.
- **Ownership**: views.css styles only selectors under `.v-library`,
  `.v-add`, `.v-edit` and `.v-settings`. perform.css styles only selectors
  under `.v-perform`, `.v-sync` and `.lyric-*`. View roots carry their
  `.v-*` class.

## UX spec

### Visual language
- Dark, minimal, legible from about 2 m away. System font stack. Lyrics use
  weight 700.
- Color tokens are CSS custom properties on `:root`, and each theme is a
  `[data-stage-theme=…]` block on `<html>`:
  - **stage**: background `#000`, text `#f2f2f2`, current line and accent
    amber `#ffcc33`, muted `#8a8a8a`, surfaces `#121212` / `#1c1c1c`.
  - **contrast**: background `#000`, text `#fff`, current line `#ffff00`.
  - **daylight**: background `#fff`, text `#111`, current line `#0047ff`.
- The base lyric size doesn't change on rotation:
  `font-size: calc(clamp(36px, 5vmax, 104px) * var(--font-scale))`. Lines
  wrap with `text-wrap: balance` and `line-height: var(--line-spacing)`.
- Line opacity:

  | Line | Opacity |
  |---|---|
  | Current | 1, in the current-line color |
  | Next sung line | 0.95 |
  | Lines after that | 0.85 → 0.55 in steps of 0.1, never below 0.5 |
  | Previous sung line | 0.45 |
  | Older lines | 0.25 |

- Section captions are about 0.38em, uppercase, letter-spaced, muted, and sit
  above their line.
- Gap markers are a fixed-height (0.6em) "♪" spacer.
- Global CSS: `html, body { overscroll-behavior: none; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; background: var(--bg) }`.
- Safe-area insets go on the bars and the column:
  `padding-inline: max(16px, env(safe-area-inset-left), env(safe-area-inset-right))`.
- index.html meta tags:
  - `viewport`: `width=device-width, initial-scale=1, viewport-fit=cover`
  - `theme-color`: `#000`
  - `mobile-web-app-capable` and `apple-mobile-web-app-capable`: `yes`
  - `apple-mobile-web-app-status-bar-style`: `black-translucent`
  - `apple-touch-icon` link, plus the manifest link. All URLs relative.

### Library (home, `#/`)
- **Header**: app name, "+ Add song" (primary, large) and a settings gear.
- **Banners**: at most one at a time, dismissible (stored in
  `settings.dismissed`), in this priority order:
  1. Resume session: "Resume ‹title› at m:ss".
  2. Update ready.
  3. Memory storage: "Storage unavailable: songs will be lost when this tab
     closes. Export a backup."
  4. iOS browser tab (`caps.iosBrowserTab`): "Install StageLyrics to your
     Home Screen before adding songs. Safari and the installed app keep
     separate libraries, and Safari can clear unused site data after 7
     days." (with a "How?" link that explains Share → Add to Home Screen).
  5. Backup reminder: shown when there are ≥ 10 songs and either there has
     never been an export or the last one is older than 30 days. "Back up
     your library" with an Export button.
- **Filter**: a sticky filter box that matches title, artist and album with
  `normalizeForMatch`. Esc clears it. `/` focuses it.
- **Sort**: a segmented control with Recent / Title / Artist, saved to
  `settings.librarySort`. Recent sorts by lastPlayedAt, then updatedAt,
  descending.
- **Song rows** are at least 64px tall:
  - Content: title (bold), "artist · m:ss", a timing badge (`Synced` green,
    `Tapped` blue, `Estimated` grey), a mode tag when it isn't Track, and a
    "▶" affordance.
  - Tapping a row opens perform.
  - "⋯" opens a sheet with Perform / Edit / Sync by tapping / Delete. Delete
    asks for confirmation.
  - readOnly songs show an "Update app to edit" badge.
- **A–Z rail** (Title and Artist sorts only): a jump rail on the right edge,
  48px wide, with letter hit areas at least 48px tall when there's room
  (otherwise letters are grouped). Tapping a letter scrolls to the first
  matching row.
- **Remembered state**: filter text, sort, scroll position and the selected
  row are kept in module state across navigation and restored on render. The
  song just performed becomes the selected row.
- **Keyboard**: ↑/↓ moves the selection and Enter opens the selected song.
  `settings.pedalKeys.next`/`prev` also move the selection, so a pedal can
  pick the next song.
- **Empty state**: "No songs yet", "+ Add a song", "Try the demo song". In
  standalone mode it adds: "Added songs in Safari before installing? Import
  your backup in Settings."

### Add song (`#/add`)
- Fields: Title (autofocus, enterkeyhint=search), Artist, and a "Search
  lyrics" button. Enter submits.
- One AbortController per search. A new search or leaving the view aborts
  the previous one. Results render only if their search sequence number is
  still the latest. `aborted` errors show nothing.
- **Results** (`rankCandidates`) show:
  - title, artist, album and duration;
  - a badge: `Synced ⏱` (green), `Plain` (grey) or `Instrumental`.

  Tapping a result opens an inline preview: the first 8 sung lines, the
  timing type, and buttons for **Save & perform** (primary), **Save to
  library** and **Back to results**.
- **Messages**:
  - `offline`: "You're offline. You can still paste lyrics below."
  - `network` / `timeout` / `busy`: "Couldn't reach the lyrics service. Try
    again, or paste lyrics below."
  - No results: "No lyrics found for “…”. Check the spelling, try without
    the artist, or paste them below."
- **"Paste lyrics instead"** is always available as a collapsible section.
  It uses the same title and artist fields, a textarea (plain or LRC,
  auto-detected with a live hint such as "Detected timed lyrics (LRC), 42
  lines" or "Plain lyrics, 42 lines: timing will be estimated"), a
  duration field (m:ss, required for plain text, validated with
  parseTime), and Save.
- **Duplicate guard**: if `sameSong` matches an existing song, ask "Already
  in your library" with "Open existing" or "Add another copy".

### Perform (`#/song/:id/perform`, `kind: 'perform'`)
**Layout**
- The root is `position: fixed; inset: 0; height: 100vh; height: 100dvh;
  overflow: hidden; touch-action: none; user-select: none;
  -webkit-user-select: none; -webkit-touch-callout: none;
  overscroll-behavior: none`, with a non-passive `gesturestart` handler that
  calls `preventDefault` (stops iOS pinch).
- The lyric column (`ui/lyric-column.js`) is absolutely positioned and moved
  with `transform: translate3d(0, y, 0)` and `transition: transform var(--scroll-ms, 450ms) cubic-bezier(.2,.7,.2,1)`.
  - `y = anchor × root.clientHeight − offsetTop(target line)`, where the
    target is the current line, or its section caption if it has one so the
    caption stays visible.
  - Measurements happen after mount. A ResizeObserver on the root and the
    column triggers re-measurement, coalesced to one per frame. Never use
    `window.innerHeight` or `orientationchange`.
  - Apply the transform with `transition: none` (restored on the next
    frame) on the first layout, after a re-measure, when the index jumps by
    more than 3 lines, after a resync with drift, and always under
    `prefers-reduced-motion: reduce`.
- **Nothing that appears or disappears during playback may move a line.**
  - The countdown pill, the HOLD pill and the pre-start hint are in an
    absolutely positioned overlay layer, placed from the measured position of
    their target line. The pre-start hint goes above the anchor area and
    never covers line 1.
  - Every line has a fixed-height progress slot (4px plus a margin). Only
    the bar inside it changes visibility and `transform: scaleX(p)`.
- **Render loop** (rAF; stops when `ctx.signal` aborts and isn't
  rescheduled while `document.hidden`):
  - `t = clock.tick()`.
  - The scroll target is `activeLineIndex(lines, t + scrollLead, offset)`,
    so the column starts moving `scrollLead` early and has settled when the
    line begins.
  - The highlighted line is `activeLineIndex(lines, t, offset)`.
  - Write the transform and classes only when these indices or the layout
    change. Per-frame writes are limited to the progress bar and the pill
    text, and the pill text is written only when its displayed integer
    changes.
  - On `visibilitychange`→visible and `pageshow`: `clock.resync()`, then
    resume the loop.

**Modes** (`session.mode`, starts from `song.mode`, saved to the song with a 500 ms debounce on change)
- **Track**: the clock runs freely. Countdowns use `gapInfo`.
- **Band**: on each tick, `h = holdPoint(lines, t, offset, duration, { threshold: gapThreshold, lead: holdLead })`.
  - If `h !== null`, `h !== session.releasedHold`, and `t >= h`: call
    `clock.seek(h, 'hold')` and `clock.pause()`, and set state to `held`. The
    pill reads "HOLD · next when you come in".
  - A next cue resumes through `cueIndex`. Pressing play while held resumes
    from h and sets `releasedHold = h`, so the same point doesn't hold
    again. A user seek resets `releasedHold`.
  - The outro never holds. While a hold is approaching, the countdown shows
    "♪ ~0:12".
- **Manual**: no clock (it's paused). Next/prev step `session.manualIndex`
  across sung lines. Countdown and progress bar are hidden. The scroll
  happens on the press.
- **Switching modes**:
  - Manual → Track/Band: seek to `D(manualIndex)` and stay paused until the
    next cue or play.
  - Track/Band → Manual: pause, and `manualIndex` becomes the current sung
    line (or the first one).
- The top bar has a segmented "Track · Band · Manual" control. M cycles the
  mode.

**Cues** (pedal or keyboard next/prev, or a line tap while the controls are visible)
- **Track/Band**: `i = cueIndex(lines, clock.time, offset, dir)`.
  - If `i !== -1`: `clock.seek(D(i), 'cue')`. Then, if the clock is paused
    and either `dir === 'next' && settings.pedalNextStarts` or the session
    was held, call `clock.play()`.
  - **Pre-start** (session not started, time 0, paused): next means "line 1
    starts now" (seek to D(first) and play). prev means "start from the top"
    (play from 0, so the intro and its countdown run).
  - When `clock.ended`, cues do nothing. Only Restart restarts.
  - Cues are session-only and never change `song.offset`.
- **Line tap** (controls visible): Track/Band seek to that line's display
  time, and play only if already playing. Manual sets `manualIndex`.
- **Debounce**: next/prev presses within `pedalDebounceMs` of the last
  accepted one, or with `e.repeat`, are ignored. Play/pause has a 250 ms
  debounce and ignores `e.repeat`.
- **First play**: the first time playback starts in a session, call
  `store.markPlayed` (fire and forget) and `wakeLock.request()`. Request the
  wake lock again on every play or cue gesture.

**Touch**
- **Controls hidden**: any tap only shows the controls. Taps never seek or
  change lines. Drags and swipes do nothing.
- **Controls visible**:
  - Tapping a lyric line cues it, as above.
  - Tapping empty space hides the controls.
  - The scrubber seeks on `change` (release) only, never on `input`. Its
    label updates live while dragging.
- **Leaving while playing**: "← Library" and Esc need a second press within
  2 s. The first press changes the button label to "Tap again to leave"
  inline; there's no dialog.
- **touchLock**: every touch is ignored except a long press of at least 1 s
  on a small lock icon in the corner, which unlocks touch for 10 s. Pedals
  and keys keep working.

**Controls overlay** (auto-hides 3 s after the last interaction while playing, when autoHideControls is on)
- Every control is a `<button type="button" tabindex="-1">`. It calls
  `preventDefault()` on `pointerdown` so it never takes focus, and blurs
  after activation. **Key presses never reveal the overlay.** Only a touch,
  H, or ? does.
- **Top bar**:
  - ← Library and the title · artist.
  - The mode segmented control.
  - A− / A+.
  - Fullscreen, only when `caps.fullscreen`.
  - A wake-lock dot: green when held, amber when not, with the title "Screen
    may sleep".
  - "⚙" opens an in-view sheet with font size, line spacing, anchor, theme,
    countdown, line progress and touchLock. It never changes the route and
    saves through ctx.saveSettings.
- **Bottom bar**:
  - ⏮ prev, ▶/❚❚, ⏭ next.
  - The scrubber with elapsed / −remaining.
  - Offset −0.5 / value / +0.5.
  - Tempo −2% / value / +2%.
  - In Manual mode, the scrubber, offset and tempo are hidden.
  - At the end, ▶ becomes "Restart" and a "Library" button appears.
- **Pre-start hint** (not covering line 1): "Press ▶, Space, or your
  pedal as you sing the first line". In Track/Band it adds "◀ starts the
  intro countdown". If the wake lock isn't held it adds "Screen may sleep:
  set Auto-Lock to Never". In an iOS browser tab with no fullscreen it adds
  a one-time hint: "For full screen: Share → Add to Home Screen".
- **Saving**: offset, tempo and mode changes are saved to the song with a
  500 ms debounce (`patchSong`), and flushed on destroy and on
  `visibilitychange`→hidden.

**End of song**: the outro and last lines stay in place. Nothing covers the
lyric column.

**Keys** (perform)

| Action | Keys |
|---|---|
| Next cue | `settings.pedalKeys.next` |
| Previous cue | `settings.pedalKeys.prev` |
| Play/pause (Track/Band) | Space, Enter, K (in Manual mode, Space and Enter = next) |
| Offset −/+0.5 s | `[` / `]` |
| Tempo −/+2 % | `,` / `.` |
| Font size | `-` / `=` or `+` |
| Cycle mode | M |
| Fullscreen | F, when supported |
| Show controls | H or ? |
| Esc | If fullscreen, exit fullscreen only. Else, if playing, show the controls. Else, back to the library. Ignored for 300 ms after any fullscreenchange. |

pedalKeys take precedence over the defaults.

### Sync by tapping (`#/song/:id/sync`, `kind: 'sync'`)
- **Before starting**: the instructions read "Start the track on your
  speaker, press Start at the very beginning, then tap (or press Space or
  your pedal) as each line begins." There's a big Start button, which
  requests the wake lock.
- **Recording**:
  - A Clock runs. The lyric column looks like perform (via
    `ui/lyric-column.js`), and the next line to tap is highlighted. Gap
    markers are skipped and interpolated later.
  - A huge TAP area covers the bottom 40% of the screen, with a pointerdown
    handler.
  - Space, Enter, or any next pedal key records `taps[i] = clock.time` and
    advances.
  - Backspace, ←, or the Undo button removes the last tap and steps back.
  - Restart, Cancel and "Finish & save" are available. Untapped lines are
    estimated.
- **Saving**: `applyTappedTimes`, then `putSong`, then navigate to edit.
  Duration becomes `max(duration, clock.time)`.
- Follows the no-interruption rule.

### Edit (`#/song/:id/edit`)
- Fields: title, artist, album, duration (m:ss), mode (Track/Band/Manual) and
  the lyrics textarea (`lyricsToEditableText(song)`). Save runs
  `updateSongText` + `retime`, then `putSong`.
- If the user strips the timestamps from a synced or tapped song, warn that
  it will become estimated.
- **Estimated songs**:
  - Intro lead-in and outro sliders, in seconds, with Auto checkboxes for
    null.
  - A live "first line at m:ss".
  - A notice: "Timing is estimated from the song length. For tight timing,
    use Sync by tapping."
- Buttons: Save, Sync by tapping →, Perform →, Delete (with confirmation),
  and "Reset to original" for LRCLIB songs, which rebuilds the song from
  rawSynced/rawPlain.
- readOnly songs: all fields are disabled, with a notice.

### Settings (`#/settings`)
- **Appearance**: every display setting, with a live preview that shows the
  actual px size and "about N lines visible ahead" for the current viewport.
  Theme swatches, mirror, uppercase and toggles.
- **Performance**: gap threshold, scroll lead, hold lead, pedalNextStarts,
  touchLock and auto-hide.
- **Pedal setup**: a wizard. "Press your BACK pedal…" then "Press your
  FORWARD pedal…" records `e.key` into `settings.pedalKeys`, with a live
  test lamp that lights on each press. "Reset to defaults".
- **Stage check** (✓ / ✗, and each ✗ explains its fix):
  - Works offline: the SW is controlling and every ASSET is cached.
  - Screen stays awake: the wake lock is supported. A "Test" button holds it
    for 5 s.
  - Storage persisted.
  - Full screen available, or standalone mode.
  - Songs saved (count).
  - Last backup.
- **Library backup**:
  - Export JSON downloads `stagelyrics-backup-YYYY-MM-DD.json`. The Blob URL
    is revoked after 60 s. When `navigator.canShare?.({ files: [file] })`
    is true, a "Share…" button is also offered.
  - Import JSON uses a file picker with
    `accept=".json,application/json,text/plain"` and never checks the MIME
    type. Choose merge or replace. Show the result counts and errors.
  - Delete all songs needs a double confirmation.
- **Keyboard and pedal reference** table.
- **About**: lyrics come from LRCLIB (lrclib.net), a free community lyrics
  database. Credit it and link to it. Explain that on iOS the Home Screen app
  and Safari keep separate libraries.

### Service worker (`sw.js`)
- **Assets**: `const VERSION = '<8 hex>'` and
  `const ASSETS = [ './', 'index.html', 'manifest.webmanifest', 'css/…', 'js/…', 'icons/…' ]`
  list every shipped runtime file (not tests, tools or docs). `npm run sw:stamp`
  (`tools/stamp-sw.mjs`) regenerates both. VERSION is the first 8 hex chars
  of the SHA-256 over the sorted asset paths and contents.
- **install**: `cache.addAll(ASSETS.map(u => new Request(new URL(u, self.registration.scope), { cache: 'reload' })))` into
  `'stagelyrics-' + VERSION`. No skipWaiting.
- **activate**: delete every `stagelyrics-*` cache except the current one,
  then `clients.claim()`.
- **fetch**: only GET requests whose URL starts with
  `self.registration.scope`. Navigations get the cached `index.html`, with
  the network as a fallback. Other in-scope requests are cache-first
  `{ ignoreSearch: true }`, with the network as a fallback. Cross-origin
  requests (LRCLIB) are never intercepted.
- **message**: `{ type: 'SKIP_WAITING' }` calls `self.skipWaiting()`.
- **Manifest**:

  | Field | Value |
  |---|---|
  | name | StageLyrics |
  | short_name | StageLyrics |
  | start_url | `./` |
  | scope | `./` |
  | id | `./` |
  | display | standalone |
  | display_override | `['fullscreen', 'standalone']` |
  | background_color | `#000` |
  | theme_color | `#000` |
  | orientation | any |
  | icons | 192, 512, and maskable 512 |

## Testing
- `npm test` runs `node --test "tests/unit/*.test.js"`.
  - Pure modules cover every contract and edge case above.
  - store.js is tested through `createMemoryStore` and the settings, live and
    import validation helpers.
  - A unit test checks that sw.js ASSETS equals the set of shipped runtime
    files and that VERSION matches the stamp.
- `npm run test:e2e` (`tests/e2e/run.mjs`):
  - Starts `tools/serve.mjs` on a free port.
  - Loads Playwright with `createRequire(import.meta.url)('playwright')`. On
    this machine it resolves through NODE_PATH; in CI it comes from
    devDependencies.
  - Contexts that mock LRCLIB use `{ serviceWorkers: 'block' }` and
    `page.route('https://lrclib.net/**')` with the fixture JSON.
  - Flows:
    1. Search → save & perform → lines advance with time.
    2. Paste plain lyrics → estimated → edit → save.
    3. Library filter and sort.
    4. Settings persist across reload.
    5. Export/import round trip.
    6. Pedal keys: cue semantics, debounce, no double-fire on a focused
       button.
    7. Band mode holds at a break and resumes on next.
    8. Reload mid-song restores the session (±1 s).
    9. After 10 library → perform → library round trips,
       `__sl.rafLoops === 0` and `__sl.liveViews === 1`.
    10. One SW-enabled run: load, wait for `serviceWorker.ready`, go
        offline, reload, and the library renders and the demo plays.
