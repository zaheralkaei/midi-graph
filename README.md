# midi-graph

Upload a MIDI or MusicXML file. Get a visual map of which notes follow which. See the sheet music. Hear it played back in the browser.

The app builds a Markov-style transition graph from the note sequence (note A → note B, with the empirical probability of that transition) and renders it as a force-directed D3 graph you can drag, filter, and zoom. Stats panel shows total notes, unique pitches, all transitions (sorted by probability), self-loop rate, and pitch range. Playback is real audio via Tone.js — the browser can't decode `.mid` natively, so we parse the file entirely client-side. MusicXML files additionally get a sheet music render via OSMD (OpenSheetMusicDisplay).

**100% static.** No server, no Python, no install. The whole app is HTML + JS + CSS. Drag the folder onto Netlify and you're done.

## Run locally

Just open `index.html` in a browser. Or, if you want to serve over HTTP (recommended — `fetch()` for the demo file needs a real URL):

```
python -m http.server 8000
# open http://localhost:8000
```

## Deploy to Netlify

**Drag-and-drop**: go to https://app.netlify.com/drop, drop this folder. Done. Netlify serves the static files; no build step.

**CLI**:

```
netlify deploy --prod --dir=.
```

**Git-based**: push to GitHub, connect the repo at app.netlify.com, deploy.

`netlify.toml` is optional — it's just `publish = "."` with no build command. Without it, Netlify defaults to publishing the repo root, which is what we want.

## What you get

- **Graph** — every unique pitch in the file is a node, every observed transition is a directed edge. Edge thickness is proportional to probability. Self-loops (A→A) get their own arc.
- **Stats** — note count, unique pitches, total transitions, self-loop count + share, pitch range, ALL transitions (sorted by probability).
- **Filter** — minimum probability, minimum/maximum pitch range. Pitch-class color coding on/off. Edge thickness on/off.
- **Playback** — Tone.js PolySynth with real note durations (note_on → matching note_off) and multi-tempo support (a piece that changes tempo plays at the right speed throughout).
- **Sheet music** (MusicXML files only) — OSMD renders the score as SVG inside the browser. MIDI files don't carry notation data, so this panel only appears for `.musicxml` / `.xml`.

## Supported formats

- `.mid`, `.midi` — Standard MIDI. Parsed by `js/midi.js` directly in the browser (no library, no server).
- `.musicxml`, `.xml` — MusicXML 3.1 partwise and timewise. Parsed by `js/musicxml.js` using the browser's built-in `DOMParser`. Sheet music rendered by OSMD.
- `.mxl` — Compressed MusicXML (a ZIP with `META-INF/container.xml`). Unzipped in-browser via the vendored `fflate` library; rootfile is read and routed through the same `js/musicxml.js` parser.

Both formats produce the same event shape internally, so transitions, stats, graph, and playback all work identically regardless of source.

## Controls

- Drag any node to reposition it
- Mouse wheel / pinch to zoom
- Zoom in / Zoom out / Reset buttons
- Min probability slider hides weak edges
- Min/max pitch sliders hide out-of-range notes
- "Color by pitch class" toggle: 12 distinct colors per chromatic class, or single accent color
- "Load demo" buttons load J.S. Bach's Allemande from Violin Partita No. 2 in D minor (BWV 1004). The MIDI form (`vp2-1all.mid`, 1094 notes, 30 pitches) and the compressed MusicXML form (`ya-tyra.mxl`, 243 notes, 8 pitches including 2 quarter-tones) are the same melody; the MIDI export lost microtonal resolution, so the .mxl version preserves A#↑3 and D#↑4 quarter-tones.

## Files

```
index.html               # entry point — upload + stats + sheet + graph + playback UI
css/style.css            # all styles
js/midi.js               # .mid parser, transition graph, stats (browser + node)
js/musicxml.js           # MusicXML parser (browser + node via @xmldom/xmldom)
js/graph.js              # D3 force-directed rendering
js/playback.js           # Tone.js playback (real durations, multi-tempo)
js/sheet.js              # OSMD sheet music rendering (MusicXML only)
js/app.js                # glue layer — wires the modules together
examples/
  vp2-1all.mid            # demo file — Bach Allemande BWV 1004, MIDI form (no quarter-tones)
  ya-tyra.mxl             # same piece — compressed MusicXML (with quarter-tones)
scripts/
  serve-nocache.py        # local dev server with no-cache headers
tests/
  midi.test.js           # node smoke tests for midi.js (parsing, transitions, stats, multi-tempo, rounding)
  musicxml.test.js       # node smoke tests for musicxml.js (parsing, quarter-tones, multi-tempo sweep)
netlify.toml             # optional — `publish = "."`
package.json             # devDependencies only (@xmldom/xmldom for tests)
```

## Tests

```
npm install              # one-time: gets @xmldom/xmldom + fflate for tests
node tests/midi.test.js
node tests/musicxml.test.js
```

90 tests covering parsing, transitions, stats, multi-tempo timing (MIDI + MusicXML), banker's-rounding for eighth-tones, negative-cents guards, .mxl extraction, content-sniffing file routing, and the real example files.

## Limits

- 16 MB upload cap (client-side check, mirrors the old server limit)
- MIDI format 0 and 1 (which is what virtually every `.mid` you'll find is)
- SMPTE-timed MIDI files are rejected (extremely rare)
- Multi-tempo playback works correctly (MIDI: tempo changes via meta-events; MusicXML: `<direction>` elements are processed in document order)
- Quarter-tones (alter = ±0.5, ±1.5) are preserved exactly through parsing, transitions, stats, and Tone.js playback. Eighth-tones (alter = ±0.25, ±0.75) round to the nearest quarter-tone for display only — graph nodes, transitions, and stats are all exact in cents

## License

MIT. See [LICENSE](LICENSE).