# midi-graph

Upload a MIDI or MusicXML file. Get a visual map of which notes follow which. See the sheet music. Hear it played back in the browser.

The app builds a Markov-style transition graph from the note sequence (note A → note B, with the empirical probability of that transition) and renders it as a force-directed D3 graph you can drag, filter, and zoom. Stats panel shows total notes, unique pitches, top transitions, self-loop rate, and pitch range. Playback is real audio via Tone.js — the browser can't decode `.mid` natively, so we parse the file entirely client-side. MusicXML files additionally get a sheet music render via OSMD (OpenSheetMusicDisplay).

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
- **Stats** — note count, unique pitches, total transitions, self-loop count + share, pitch range, top 5 transitions.
- **Filter** — minimum probability, minimum/maximum pitch range. Pitch-class color coding on/off. Edge thickness on/off.
- **Playback** — Tone.js PolySynth with real note durations (note_on → matching note_off) and multi-tempo support (a piece that changes tempo plays at the right speed throughout).
- **Sheet music** (MusicXML files only) — OSMD renders the score as SVG inside the browser. MIDI files don't carry notation data, so this panel only appears for `.musicxml` / `.xml`.

## Supported formats

- `.mid`, `.midi` — Standard MIDI. Parsed by `js/midi.js` directly in the browser (no library, no server).
- `.musicxml`, `.xml` — MusicXML 3.1 partwise and timewise. Parsed by `js/musicxml.js` using the browser's built-in `DOMParser`. Sheet music rendered by OSMD.

Both formats produce the same event shape internally, so transitions, stats, graph, and playback all work identically regardless of source.

## Controls

- Drag any node to reposition it
- Mouse wheel / pinch to zoom
- Zoom in / Zoom out / Reset buttons
- Min probability slider hides weak edges
- Min/max pitch sliders hide out-of-range notes
- "Color by pitch class" toggle: 12 distinct colors per chromatic class, or single accent color
- "Load demo" buttons load Bach's Minuet in G (first 8 bars) — both MIDI and MusicXML versions

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
  minuet.mid             # demo file (Bach, Minuet in G)
  minuet.musicxml        # same melody, MusicXML form
scripts/
  build-example.js       # regenerates examples/minuet.mid
  build-musicxml-example.js # regenerates examples/minuet.musicxml
tests/
  midi.test.js           # 26 node smoke tests for midi.js
  musicxml.test.js       # 16 node smoke tests for musicxml.js
netlify.toml             # optional — `publish = "."`
package.json             # devDependencies only (@xmldom/xmldom for tests)
```

## Tests

```
npm install              # one-time: gets @xmldom/xmldom for MusicXML tests
node tests/midi.test.js
node tests/musicxml.test.js
```

42 tests covering parsing, transitions, stats, multi-tempo timing, microtonal alter rounding, and the real example files.

## Limits

- 16 MB upload cap (client-side check, mirrors the old server limit)
- MIDI format 0 and 1 (which is what virtually every `.mid` you'll find is)
- SMPTE-timed MIDI files are rejected (extremely rare)
- Microtonal MusicXML alters (`-1.5`, `0.5` etc.) round to the nearest MIDI semitone for now; full quarter-tone support in playback is a future enhancement
- Multi-tempo playback works correctly; single global tempo was the old limitation

## Regenerate the demos

```
node scripts/build-example.js           # writes examples/minuet.mid
node scripts/build-musicxml-example.js  # writes examples/minuet.musicxml
```

Both produce the same 41-note Bach Minuet phrase so you can verify the two parsers produce equivalent output.

## License

MIT. See [LICENSE](LICENSE).