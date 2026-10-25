// Cleans lyrics text copied from a web page (search results, lyric sites).
// Removes common page junk while keeping lyric lines and section headers.
// Pure, so it never touches the DOM.

const JUNK_LINE = [
  /^\d*\s*embed$/i,                                  // "Embed", "45Embed"
  /^\d+\s*contributors?/i,                           // "12 Contributors", "12 ContributorsTranslations…"
  /^translations?$/i,
  /^you might also like$/i,
  /^see .{1,80} live$/i,
  /^get tickets as low as\b/i,
  /^(songwriters?|writer\(s\)|written by|composers?|source|publisher|label)\s*:/i,
  /^lyrics (powered|provided|licensed) by\b/i,
  /^lyrics\s*©/i,
  /^©/,
  /^(read more|show more|show less|more|report|share|copy|copied|print|embed lyrics)$/i,
  /^\d+\s*(views?|plays?|likes?)$/i,
  /^(paroles|letra|songtext)$/i,
]

const INVISIBLE = /[​-‍⁠﻿]/g

/** @param {string} text @returns {string} cleaned lyrics, lines joined by '\n' */
export function cleanPastedLyrics(text) {
  if (typeof text !== 'string' || !text) return ''
  const raw = text
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[   \t]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())

  const out = []
  let seenContent = false
  for (const line of raw) {
    if (!line) {
      out.push('')
      continue
    }
    if (JUNK_LINE.some((re) => re.test(line))) continue
    // A "Song Title Lyrics" page header, only before any lyric content
    if (!seenContent && /\blyrics$/i.test(line) && line.length <= 120) continue
    seenContent = true
    out.push(line)
  }

  // Sites often glue a counter onto the last lyric line: "…last words45Embed"
  for (let i = out.length - 1; i >= 0; i--) {
    if (!out[i]) continue
    out[i] = out[i].replace(/\d*\s*Embed$/, '').trim()
    break
  }

  // Collapse blank runs to a single blank line and trim the ends
  const result = []
  for (const line of out) {
    if (!line && (!result.length || !result[result.length - 1])) continue
    result.push(line)
  }
  while (result.length && !result[result.length - 1]) result.pop()
  return result.join('\n')
}
