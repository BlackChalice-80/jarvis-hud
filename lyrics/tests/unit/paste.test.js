import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanPastedLyrics } from '../../js/paste.js'

// Original placeholder text only, shaped like a copied lyrics web page.
const PAGE = `
12 ContributorsTranslationsEspañol
Paper Lanterns Lyrics
[Verse 1]
Paper lanterns over the river
Carry   every wish we made



[Chorus]
Hold the light and let it wander
You might also like
Nothing here is meant to fade
See The Placeholders Live
Get tickets as low as $20
Paper lanterns over the river45Embed
`

test('removes page junk and keeps lyrics and section headers', () => {
  assert.equal(
    cleanPastedLyrics(PAGE),
    [
      '[Verse 1]',
      'Paper lanterns over the river',
      'Carry every wish we made',
      '',
      '[Chorus]',
      'Hold the light and let it wander',
      'Nothing here is meant to fade',
      'Paper lanterns over the river',
    ].join('\n'),
  )
})

test('drops credit footers like those under search-result lyric panels', () => {
  const text = 'Line one of a song\nLine two of a song\n\nSongwriters: Nobody Real / Also Fictional\nSource: Example Lyrics Provider'
  assert.equal(cleanPastedLyrics(text), 'Line one of a song\nLine two of a song')
})

test('keeps a lyric line that merely ends with the word lyrics after content started', () => {
  const text = 'First line here\nI keep writing lyrics'
  assert.equal(cleanPastedLyrics(text), text)
})

test('handles CRLF, BOM, zero-width characters and empty input', () => {
  assert.equal(cleanPastedLyrics('﻿One​ line\r\nTwo line\r\n'), 'One line\nTwo line')
  assert.equal(cleanPastedLyrics(''), '')
  assert.equal(cleanPastedLyrics(null), '')
  assert.equal(cleanPastedLyrics('\n\n  \n'), '')
})

test('leaves LRC timestamps intact', () => {
  const lrc = '[00:01.00] Hello there\n[00:03.50] Second line'
  assert.equal(cleanPastedLyrics(lrc), lrc)
})
