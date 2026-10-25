# StageLyrics — spec and module contracts

A lyrics prompter for vocalists performing live. You add a song, the app finds
its lyrics and duration online, and the lyrics then scroll in time with the
music. The text is large, and most of the screen shows lines that are still
coming.

This is the v1 contract. Every module below has a fixed public API so modules
can be built and tested independently. If you change a signature, update this
file in the same commit.

## Goals for v1

1. **Add a song.** Type the title and artist. The app searches LRCLIB, lists
   the matches (marking which ones have synced timing), and you pick one. If
   there's no match, you can paste lyrics (plain or LRC) and type the duration.
2. **Timing.**
   - *Synced* LRC (`[mm:ss.xx] line`) is used as-is.
   - *Plain* lyrics get estimated times spread across the duration, weighted
     by syllables, with an intro lead-in, an outro, and gaps between verses.
   - *Tap-to-sync*: play the track and tap on each line to record real
     timestamps.
   - A per-song offset and tempo rate handle live arrangements that drift from
     the recording.
3. **Perform.** Huge, high-contrast text. The current line sits about 30%
   down the screen so most of the view is upcoming lyrics. Scrolling is
   smooth. Gaps show an "instrumental" countdown and the intro shows "first
   line in N". Controls hide automatically. Foot pedals and keyboards work
   (Bluetooth page turners send arrow / PageUp / PageDown keys). There's a
   manual (pedal-step) mode for when timing can't be trusted. The screen
   stays awake.
4. **Library.** Every added song is stored on the device (IndexedDB). It opens
   instantly, filters as you type, sorts by recent or A–Z, works offline, and
   can be exported and imported as JSON.
5. **Offline-first PWA.** The app shell is cached by a service worker. Only
   adding a new song via search needs the network.

Out of scope for v1 (planned next): setlists, listening to the band's audio
for automatic sync, cloud sync between devices, and word-level karaoke.

## Hard rules

- **No copyrighted lyrics in the repo.** Demo songs, fixtures, and test data
  use ORIGINAL placeholder lines written for this project ("Check one, check
  two, the lights are coming up..."). Never paste real song lyrics into code,
  tests, docs, or commit messages. Lyrics only enter the app at runtime from
  LRCLIB or from what the user pastes.
- Vanilla ES modules with no build step and no runtime dependencies. It must
  run from any static file server and on GitHub Pages under a sub-path
  (`/jarvis-hud/lyrics/`), so every URL is **relative**.
- Pure modules (`lrc.js`, `timing.js`, `clock.js`, `song.js`, `lrclib.js`,
  `format.js`) must not touch `document` or `window` at import time, so Node
  can import and unit-test them. `lrclib.js` takes an injectable `fetch`.
  `clock.js` takes an injectable `now()`.
- Use the system font stack (no web fonts), because the app has to render
  offline at a venue.
- Target the latest iPad/iPhone Safari, Chrome (Android and desktop), and
  Firefox. Touch targets are at least 48px.

## File layout

```
lyrics/
  index.html               app shell; <main id="app">; loads js/main.js as type=module
  manifest.webmanifest
  sw.js                    service worker (app-shell cache, versioned)
  icons/icon.svg, icons/icon-192.png, icons/icon-512.png, icons/apple-touch-icon.png
  css/app.css
  js/
    main.js                bootstrap: settings, store, router, SW registration, global key handling
    router.js              hash router
    format.js              formatting helpers (pure)
    lrc.js                 LRC + plain-text lyric parsing/serialization (pure)
    timing.js              timing estimation + playback-position math (pure)
    clock.js               playback clock (pure, injectable now())
    song.js                Song model: create/normalize/retime/migrate (pure)
    lrclib.js              LRCLIB API client (pure, injectable fetch)
    store.js               IndexedDB song library + settings persistence
    demo.js                original demo song (pure data)
    ui/dom.js              h() element helper, icons, toast, confirm dialog
    ui/library-view.js
    ui/add-view.js
    ui/edit-view.js
    ui/sync-view.js
    ui/perform-view.js
    ui/settings-view.js
  tests/
    unit/*.test.js         node --test (node:test + node:assert/strict)
    e2e/run.mjs            Playwright end-to-end smoke tests (LRCLIB mocked via page.route)
    fixtures/              original fake LRC/plain lyrics + fake LRCLIB JSON
  package.json             {"type":"module"} scripts: test, test:unit, test:e2e, serve
  README.md
```

## Data model

```js
/** @typedef {{ t: number, text: string, section?: string }} Line
 *  t       start time in seconds (song time, before the per-song offset)
 *  text    the line as displayed. '' (empty string) marks an instrumental
 *          break / stanza gap: it renders as a small "♪" spacer and is never
 *          counted as a sung line.
 *  section optional label shown above this line ("Chorus", "Verse 2"), parsed
 *          from "[Chorus]" / "Chorus:" header lines in plain text.
 */

/** @typedef {{
 *   id: string,                 // crypto.randomUUID() (fallback: random hex)
 *   title: string,
 *   artist: string,             // may be ''
 *   album: string,              // may be ''
 *   duration: number,           // seconds; > 0 (default 210 when unknown)
 *   timing: 'synced'|'estimated'|'tapped',
 *   lines: Line[],              // sorted by t ascending, t >= 0, t <= duration
 *   source: { provider: 'lrclib'|'manual'|'demo', lrclibId?: number },
 *   rawPlain: string,           // plain lyrics text (no timestamps), kept for re-estimation
 *   rawSynced: string,          // original LRC text if any, else ''
 *   estimate: { leadIn: number, outro: number },  // seconds, used when timing==='estimated'
 *   offset: number,             // seconds; positive = lyrics appear LATER
 *   rate: number,               // playback-rate multiplier for live tempo, 0.5..1.5, default 1
 *   instrumental: boolean,
 *   createdAt: number, updatedAt: number, lastPlayedAt: number|0, playCount: number,
 *   schema: 1
 * }} Song */
```

The **display time** of line `i` is `lines[i].t + song.offset`. The clock
always runs in *song time* (0 = start of the recording).

## Module contracts

### `js/format.js` (pure)
```js
export function formatTime(sec)            // 0..∞ → "m:ss" (e.g. 75.4 → "1:15"); negatives → "0:00"; NaN → "0:00"; >= 3600 → "h:mm:ss"
export function parseTime(str)             // "3:25" | "03:25" | "205" | "3:25.5" | "1:02:03" → seconds (number) | null if invalid
export function normalizeForMatch(str)     // lowercase, strip diacritics, drop "(feat. …)"/"[…]"/"- Remastered…" suffixes, collapse non-alphanumerics to single spaces, trim
export function escapeHtml(str)
```

### `js/lrc.js` (pure)
```js
export function isLrc(text)                // true if ≥ 1 line starts with a [mm:ss(.xx)] tag
export function parseLrc(text)
  // → { lines: Line[], meta: { ti?, ar?, al?, length?: number, offsetMs?: number } }
  // Handles: [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx], [mm:ss:xx]; minutes > 59; multiple
  // tags on one line ("[00:12.00][01:30.00]Chorus line" → two Lines); CRLF; BOM; metadata tags
  // [ti:] [ar:] [al:] [length: 3:25] [offset:+250] (offset ms, applied: positive offset = lyrics
  // EARLIER per LRC convention → t = t - offset/1000); word-level tags "<mm:ss.xx>" stripped from text;
  // empty-text timed lines kept as '' gap markers; untimed lines ignored; result sorted by t (stable);
  // consecutive duplicate '' gap markers collapsed; times clamped >= 0.
export function serializeLrc(lines, meta?) // Line[] → LRC string "[mm:ss.xx]text\n" (2-decimal centiseconds, minutes zero-padded to 2+),
                                           // sections emitted as a preceding untimed "[Chorus]"? NO — sections are not representable in LRC;
                                           // serializeLrc drops section labels. Round-trips: parseLrc(serializeLrc(x)).lines ≈ x (±0.01s, minus sections).
export function parsePlain(text)
  // → { lines: Array<{ text: string, section?: string }> }   (no times)
  // - trims each line, collapses runs of blank lines to ONE '' gap marker; strips leading/trailing gaps
  // - section headers: a line that is entirely "[Verse 1]" / "[Chorus: Name]" / "(Chorus)" /
  //   "Chorus:" / "Verse 2:" / "Bridge" / "Pre-Chorus" / "Intro" / "Outro" / "Hook" / "Refrain"
  //   (case-insensitive, optional number) is NOT a lyric line; its label (e.g. "Chorus", "Verse 1")
  //   is attached as `section` to the next lyric line, and a gap marker is inserted before it
  //   (unless at start or already preceded by one).
  // - a timestamped line is never treated as a header.
export function lyricsToEditableText(song) // timing 'synced'|'tapped' → serializeLrc(song.lines); 'estimated' → song.rawPlain
```

### `js/timing.js` (pure)
```js
export function countSyllables(text)       // heuristic English-ish syllable count ≥ 1 for non-empty text (vowel groups,
                                           // silent trailing e, "-le" endings); 0 for ''. Must not throw on any unicode.
export function estimateTimings(plainLines, duration, opts?)
  // plainLines: Array<{text, section?}> (from parsePlain); duration seconds
  // opts: { leadIn?: number, outro?: number, gapWeight?: number }
  //   defaults: leadIn = clamp(duration*0.07, 4, 20); outro = clamp(duration*0.06, 3, 20);
  //   gapWeight = 1.0 × mean sung-line weight
  // weight(line) = max(3, countSyllables(text)) for sung lines; gaps ('') weigh gapWeight.
  // t[i] = leadIn + (duration - leadIn - outro) * (cumulative weight before i) / totalWeight
  // If leadIn+outro >= duration*0.8, scale both down so the sung window is ≥ 20% of duration.
  // → Line[] (same length/order as input, sections preserved), monotonic non-decreasing, all within [0, duration].
  // Empty input → [].
export function activeLineIndex(lines, displayTime, offset = 0)
  // largest i with lines[i].t + offset <= displayTime, else -1. Binary search. Gap markers count as lines.
export function nextSungIndex(lines, fromIndex)  // smallest j > fromIndex with lines[j].text !== '', else -1
export function prevSungIndex(lines, fromIndex)  // largest j < fromIndex with lines[j].text !== '', else -1
export function firstSungIndex(lines)            // nextSungIndex(lines, -1)
export function lineProgress(lines, i, time, offset, duration)
  // 0..1 progress through line i: (time - start) / (end - start) where end = next line's start (or duration)
  // clamped; i<0 → 0.
export function gapInfo(lines, time, offset, duration, threshold = 6)
  // Describes an instrumental wait so the UI can show a countdown. Returns null or
  // { kind: 'intro'|'break'|'outro', secondsUntilNext: number, nextIndex: number, progress: 0..1 }
  // - 'intro': time is before the first sung line's display time and that is > threshold away
  //    (or 0 < remaining and the intro total ≥ threshold) — progress = elapsed/total intro.
  // - 'break': current active line is a '' gap marker, OR the current sung line started more than
  //    estLineSeconds(text) ago, and the next sung line is still ≥ 2s away and the whole wait
  //    (next start - current end) ≥ threshold.
  //    estLineSeconds(text) = clamp(countSyllables(text)*0.32, 1.5, 6).
  // - 'outro': after the last sung line has finished (estLineSeconds) — secondsUntilNext = duration - time, nextIndex -1.
export function shiftLines(lines, delta, duration) // all t += delta, clamped to [0,duration], order preserved
export function validateLines(lines, duration)     // → sorted copy with NaN removed, clamped; never throws
```

### `js/clock.js` (pure)
```js
export class Clock {
  constructor({ now = () => performance.now() / 1000, duration = Infinity } = {})
  get time()            // current song time (seconds), clamped to [0, duration]; while playing:
                        //   anchorTime + (now() - anchorWall) * rate
  get playing()         // boolean
  get rate()            // number
  get duration()
  set duration(d)
  play()                // no-op if playing; if at end (time >= duration) restarts from 0
  pause()               // freezes time
  toggle()
  seek(t)               // sets time (clamped), keeps play state, re-anchors
  nudge(dt)             // seek(time + dt)
  setRate(r)            // clamps to [0.5, 1.5]; re-anchors so time is continuous
  reset()               // pause + seek(0)
  get ended()           // time >= duration
  on(event, fn) → unsubscribe fn   // events: 'play','pause','seek','rate','ended'
  // 'ended' fires once when time reaches duration during playback (checked lazily on `time` reads
  //  and via tick()); after ended, playing becomes false and time === duration.
  tick()                // call from rAF; returns time; triggers 'ended' if needed
}
```

### `js/song.js` (pure)
```js
export const SCHEMA = 1
export const DEFAULT_DURATION = 210
export function newId()
export function songFromLrclib(track, now = Date.now())
  // track = normalized LRCLIB candidate (see lrclib.js). Prefers syncedLyrics → timing 'synced'
  // (lines from parseLrc; duration = track.duration || last line t + 5); else plainLyrics → 'estimated';
  // instrumental tracks → lines [] and instrumental true. source {provider:'lrclib', lrclibId}.
export function songFromText({ title, artist = '', album = '', text, duration }, now = Date.now())
  // text may be LRC (isLrc) → 'synced' else plain → 'estimated'. duration falsy → for LRC: max(meta.length, last t + 5),
  // for plain: DEFAULT_DURATION. source {provider:'manual'}.
export function updateSongText(song, text, now = Date.now())
  // re-parses edited lyric text: LRC → 'synced' (or keeps 'tapped' if it was tapped and still LRC) with new lines;
  // plain → 'estimated' re-estimated with song.estimate. Returns NEW song object (immutable style).
export function retime(song, patch = {})
  // patch: { duration?, leadIn?, outro? }. For 'estimated' songs recomputes lines from rawPlain.
  // For synced/tapped only updates duration (and clamps lines). Returns new song.
export function applyTappedTimes(song, times, now = Date.now())
  // times: number[] aligned to song.lines indices; entries may be null for lines not tapped.
  // Untapped trailing lines are re-estimated proportionally between the last tapped time and duration-outro;
  // untapped gap markers between taps are interpolated. Result timing 'tapped'. Lines monotonic.
export function normalizeSong(obj)         // fills defaults / migrates older shapes; sorts & clamps lines; never throws on partial input
export function songSummary(song)          // { id, title, artist, duration, timing, lineCount (sung lines only), lastPlayedAt, playCount }
```

### `js/lrclib.js` (pure, injectable fetch)
```js
export const LRCLIB_BASE = 'https://lrclib.net'
export class LrclibError extends Error { constructor(message, { status, kind }) }  // kind: 'network'|'timeout'|'http'|'notfound'|'parse'|'offline'
export function createLrclibClient({ fetch = globalThis.fetch, base = LRCLIB_BASE, timeoutMs = 10000, clientName = 'StageLyrics v0.1 (https://github.com/BlackChalice-80/jarvis-hud)' } = {})
  // → { search({ title, artist, album? }, { signal }?) : Promise<Candidate[]>,
  //     get({ title, artist, album?, duration? }, { signal }?) : Promise<Candidate|null>,   // 404 → null
  //     getById(id, { signal }?) : Promise<Candidate|null> }
  // Requests: GET {base}/api/search?track_name=…&artist_name=… (artist omitted if empty; if title empty and only a
  //   free-text query is given via search({ q }), use ?q=…). GET {base}/api/get?track_name&artist_name[&album_name][&duration]
  //   GET {base}/api/get/{id}.
  // Send header 'Lrclib-Client': clientName (server CORS allows it). No other custom headers.
  // 503 → wait Retry-After seconds (default 1, max 3) and retry ONCE. AbortSignal + timeout via AbortController.
  // Errors → LrclibError with kind. Non-JSON → kind 'parse'. navigator.onLine === false (if defined) → kind 'offline' without fetching.
export function normalizeTrack(raw)
  // LRCLIB JSON → Candidate { lrclibId, title, artist, album, duration (number seconds, 0 if missing),
  //   instrumental, hasSynced: boolean (syncedLyrics non-empty), hasPlain, syncedLyrics: string, plainLyrics: string,
  //   lineCount (sung lines from synced, else plain) }
  // Field names from the API: id, name, trackName, artistName, albumName, duration, instrumental, hasWordSync,
  //   plainLyrics, syncedLyrics, lyricsfile (ignore lyricsfile in v1).
export function rankCandidates(cands, { title, artist, duration }?)
  // stable sort: exact normalized title+artist match first, then hasSynced, then hasPlain over instrumental-only,
  // then |duration - wanted| ascending when wanted duration given; drops exact duplicates
  // (same normalized title+artist+rounded duration+hasSynced, keeping the first). Returns new array.
```

### `js/store.js` (browser; IndexedDB with in-memory fallback)
```js
export async function openStore({ name = 'stagelyrics', indexedDB = globalThis.indexedDB } = {})
  // → Store. If IndexedDB unavailable or open fails (private mode), returns an in-memory Store with
  //   store.persistent === false (UI shows a warning banner).
// Store:
//   listSongs() : Promise<Song[]>            // full objects, any order
//   getSong(id) : Promise<Song|null>
//   putSong(song) : Promise<Song>            // normalizeSong + updatedAt = now; returns saved
//   deleteSong(id) : Promise<void>
//   markPlayed(id) : Promise<void>           // lastPlayedAt = now, playCount++
//   exportJson() : Promise<string>           // { app:'stagelyrics', version:1, exportedAt, songs:[...] } pretty JSON
//   importJson(text, { mode:'merge'|'replace' }) : Promise<{ added, updated, skipped }>
//                                            // merge: by id, newer updatedAt wins; invalid entries skipped
//   clear() : Promise<void>
//   persistent : boolean
export function loadSettings(storage = globalThis.localStorage) // → Settings (defaults merged; tolerant of bad JSON/throwing storage)
export function saveSettings(settings, storage = globalThis.localStorage)
export const DEFAULT_SETTINGS = {
  fontScale: 1,            // multiplier on base lyric size (0.6..2.5)
  lineSpacing: 1.25,       // CSS line-height multiplier for lyric lines (1.0..2.0)
  anchor: 0.3,             // fraction of viewport height where the current line's top sits (0.1..0.5)
  theme: 'stage',          // 'stage' (black/white, amber current) | 'contrast' (pure black/white/yellow) | 'daylight' (white bg)
  mirror: false,           // horizontal flip for teleprompter glass
  uppercase: false,
  showSections: true,
  showCountdown: true,
  gapThreshold: 6,         // seconds; instrumental countdown appears for waits ≥ this
  lineProgress: true,      // thin progress bar under the current line
  autoHideControls: true,  // hide overlay controls 3s after last interaction while playing
  pedalNextStarts: true,   // "next" while paused starts playback (2-button pedals have no play key)
  librarySort: 'recent',   // 'recent' | 'title' | 'artist'
}
```

### `js/router.js`
```js
export function createRouter(routes, { onNotFound })  // routes: Array<[pattern, handler]>; pattern like '/song/:id/perform'
  // listens to hashchange; parses '#/song/abc/perform?x=1' → handler({ params:{id:'abc'}, query:{x:'1'} })
  // router.go(path) sets location.hash; router.start() dispatches the current hash (default '#/').
```
Routes:
| hash | view |
|---|---|
| `#/` | library |
| `#/add` | add song (search + manual paste) |
| `#/song/:id/perform` | performance view |
| `#/song/:id/edit` | edit lyrics/metadata/timing |
| `#/song/:id/sync` | tap-to-sync recorder |
| `#/settings` | settings + backup |
| `#/demo` | loads the demo song into the library (if absent) then goes to its perform view |

### Views (`js/ui/*.js`)
Each view module exports `render(ctx, route) → { el: HTMLElement, destroy?: () => void, onKey?: (e) => boolean }`.
`ctx = { store, settings, saveSettings(patch), router, lrclib, toast(msg, kind?), confirm(msg) → Promise<boolean> }`.
`main.js` mounts `el` into `#app`, calls `destroy()` on the previous view, and routes keydown events to
`onKey` first (return true = handled, preventDefault).

## UX spec

### Visual language
Dark, minimal, legible from about 2 m away. System font, weight 700 for lyrics. Color tokens live on `:root`.
Stage theme: background `#000`, text `#f2f2f2`, current line amber `#ffcc33`, accent `#ffcc33`, muted `#8a8a8a`.
Lyric base size: `font-size: calc(clamp(30px, 5.2vw, 84px) * var(--font-scale))`, with lines wrapping and
balanced (`text-wrap: balance`). Upcoming lines get opacity 0.92 for the next line, then step down to 0.55 (never
below 0.45; they must stay readable). Past lines are 0.22. Current line is opacity 1 in the accent color, with an
optional 4px progress bar beneath it.

### Library (home, `#/`)
- Header: app name, "+ Add song" (primary, large), settings gear.
- A sticky filter box that filters by title/artist/album as you type (accent-insensitive). Esc clears it.
- Sort toggle: Recent / A–Z (title) / Artist.
- Song rows are big (≥ 64px): title (bold), artist · duration, a timing badge (`Synced`, `Tapped`,
  `Estimated`), and a play chevron. Tapping a row opens perform. A "⋯" menu has Edit / Sync by tapping / Delete.
- Empty state: "No songs yet", "Add a song", and "Try the demo song".
- When the store is not persistent, a banner says: "Private mode: songs won't be saved after you close this tab."
- Keyboard: `/` focuses the filter; ↑/↓ moves the selection; Enter opens the selected song.

### Add song (`#/add`)
- Fields: Title (autofocus), Artist, then a "Search lyrics" button (Enter submits).
- While searching, show a spinner. Results come from `rankCandidates`. Each one shows title, artist, album,
  duration, and a badge: `Synced ⏱` (green), `Plain` (grey), or `Instrumental`. Tapping a result opens an
  inline preview (first ~8 lines and the timing type) with **Save & perform** (primary), **Save to library**,
  and **Back to results**.
- Errors: offline ("You're offline. You can still paste lyrics below."), timeout or network ("Couldn't
  reach the lyrics service. Try again or paste lyrics."), or no results ("No lyrics found for … — check
  spelling, try without the artist, or paste them").
- There is always a collapsible "Paste lyrics instead" section: title/artist fields shared with the search, a
  textarea (plain or LRC, auto-detected with a hint like "Detected timed LRC (42 lines)"), duration (m:ss),
  and Save.
- Duplicate guard: if the library already has a song with the same normalized title + artist, ask whether to
  open the existing one or add another copy.

### Perform (`#/song/:id/perform`)
- Full-screen lyric column. The current line's top sits at `anchor × viewport height`. The column moves with
  `transform: translate3d(0, y, 0)` and a `transition: transform 450ms cubic-bezier(.2,.7,.2,1)`. Line
  positions are measured with `offsetTop` after layout and re-measured on resize, font change, and
  orientation change.
- Gap markers render as a small "♪" spacer (smaller line). Section labels render as small uppercase muted
  captions above their line when `showSections` is on.
- Countdown: during intro, breaks, and outro (from `gapInfo`, when `showCountdown` is on), a pill appears just
  above the next sung line with "♪ 12" counting down and a thin progress ring or bar. Intro reads
  "First line in 0:12".
- Before playback starts: the first sung line is the current line, and an overlay hint reads
  "▶ / Space / pedal to start".
- Overlay controls (auto-hide while playing):
  - Top bar: ← Library, title · artist, mode toggle **Auto / Manual**, A− / A+ (font), fullscreen, settings.
  - Bottom bar: ⏮ prev line, ▶/❚❚, ⏭ next line, a time scrubber (range input, song time), elapsed / −remaining,
    offset nudge (−0.5s / +0.5s, current offset shown), tempo (−/+ 0.02, shown as "100%").
- Offset and rate changes are saved to the song (debounced 500ms) so they persist to the next gig.
- Tapping a lyric line seeks to it (Auto) or makes it current (Manual). Tapping empty space toggles the controls.
- **Auto mode**: the clock drives the current line. Next/prev seek to the next/prev *sung* line's display time.
  When `pedalNextStarts` is on and playback is paused, next also starts playback. That's how a 2-button pedal
  starts a song on cue: press next as you sing line 1.
- **Manual mode**: no clock. Next/prev step the current line, skipping gap markers. Countdown and progress bar
  are hidden.
- Keys: Space/Enter/K = play/pause; →/↓/PageDown/J/N = next; ←/↑/PageUp/P = previous; `[` / `]` = offset
  −/+0.5s; `,`/`.` = tempo −/+2%; `-`/`=` (also `+`) = font size; M = toggle mode; F = fullscreen; H or `?` = show
  controls/help; Esc = exit fullscreen, else back to library. Auto-repeat keydown events are ignored for
  next/prev (`e.repeat`).
- Screen Wake Lock is requested while the view is mounted and re-acquired on `visibilitychange`. If it's
  unsupported, the app keeps working without it.
- `markPlayed` is called the first time playback starts.
- When playback ends, the outro shows, then an "End of song" overlay with "Back to library" and "Restart".

### Edit (`#/song/:id/edit`)
- Fields: title, artist, album, duration (m:ss), and a lyrics textarea showing `lyricsToEditableText(song)`. It
  shows LRC for synced/tapped songs and plain text for estimated ones. Saving calls `updateSongText` and
  `retime`. If the user strips timestamps from a synced song, warn that it will become estimated.
- For estimated songs: intro lead-in and outro sliders (seconds) with live "first line at m:ss".
- Buttons: Save, Sync by tapping →, Perform →, Delete (with confirm), "Reset to source" (only for LRCLIB songs
  with rawSynced/rawPlain).

### Sync by tapping (`#/song/:id/sync`)
- Instructions: "Start the track, press Start at the very beginning, then tap (or press Space) as each line
  begins."
- Big Start button. Once started, a clock runs. The lyric column looks like the perform view, and the line
  waiting for a tap is highlighted. Gap markers are auto-skipped (interpolated). A huge TAP area covers the
  bottom 40% of the screen. Backspace or an Undo button removes the last tap and steps back. Restart, Cancel,
  and "Finish & save" are available (untapped lines are estimated). Saving goes through `applyTappedTimes`
  and returns to edit. The duration updates to `max(duration, clock time)` if the user taps past the end.

### Settings (`#/settings`)
- Every Settings field with live preview text ("This is how your lyrics will look on stage"). Theme
  swatches, mirror, uppercase, the toggles, anchor slider, gap threshold.
- Library backup: Export JSON (downloads `stagelyrics-backup-YYYY-MM-DD.json`), Import JSON (file picker,
  merge), Delete all songs (double confirm).
- A pedal/keyboard reference table.
- About: lyrics come from LRCLIB (lrclib.net), a free community database. Credit it and link it.

## Testing
- `npm test` (in `lyrics/`) runs `node --test tests/unit/`. Pure modules aim for full branch coverage of the
  contracts above, including the edge cases listed.
- `npm run test:e2e` starts a static server on a free port, launches Chromium through Playwright (resolved
  with `createRequire(import.meta.url)('playwright')`, since this machine provides it globally through
  NODE_PATH), intercepts `https://lrclib.net/**` with `page.route` returning fixture JSON (original fake
  lyrics), and drives these flows: add via search → perform → playback advances lines; manual paste → edit
  → save; library filter; settings persist across reload; export/import round-trip; pedal keys.
