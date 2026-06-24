# midi-graph

A 100% client-side note-transition graph for MIDI and MusicXML. Upload
a file, get a visual map of which notes follow which, see the sheet
music, hear it played back in the browser.

A note→next-note transition graph (Markov-style) is built from the parsed
note sequence. The graph is rendered as a force-directed D3 graph you can
drag, filter, and zoom. A stats panel shows total notes, unique pitches,
every transition sorted by probability, self-loop rate, and pitch range.
Playback is real audio via Tone.js — the browser can't decode `.mid`
natively, so MIDI is parsed entirely client-side. MusicXML and MIDI files
both get a sheet-music render (MusicXML directly via OSMD; MIDI via
[webmscore](https://github.com/LibreScore/webmscore), which gives you
professional-grade engraving — proper beam grouping, voice separation,
slurs, articulations, key signature, dynamics — the same quality you'd
get from desktop MuseScore).

**Live demo:** [midi-graph.netlify.app](https://midi-graph.netlify.app/).

**100% static.** No server, no Python, no install. The whole app is
HTML + JS + CSS + a 9 MB vendored WASM bundle. Just open `index.html`
in a browser, or use the live demo link above.

---

## Run locally

Just open `index.html` in a browser. For the demo buttons to work (they
`fetch()` `examples/*.mid` and `examples/*.mxl`), serve over HTTP:

```sh
python -m http.server 8000
# or, for development, use the no-cache helper:
python scripts/serve-nocache.py
# then open http://localhost:8000
```

## Deploy your own

The app is already deployed at **[midi-graph.netlify.app](https://midi-graph.netlify.app/)**
— if you want to host your own copy, the fastest options are:

- **Drag-and-drop**: go to https://app.netlify.com/drop, drop this folder.
  Done. Netlify serves the static files; no build step.
- **CLI**: `netlify deploy --prod --dir=.`
- **Git-based**: push to GitHub, connect the repo at app.netlify.com, deploy.

`netlify.toml` is included with `publish = "."` and the right
content-type headers (so `.mxl` downloads as `application/vnd.recordare.musicxml`
instead of `application/octet-stream`). If you deploy without it,
Netlify defaults to publishing the repo root, which also works.

---

## What you get

The page is laid out in a single column with the **melodic** and
**harmonic** graphs side-by-side in their own row. From top to
bottom:

1. **Title** — centered, with a subtitle left-aligned beneath.
2. **Upload** — file picker, two demo loaders (Bach Allemande `.mid`
   and ya-tyra `.mxl`), and the loaded-filename display. Always
   visible so you can swap files without scrolling.
3. **Playback** — Play / Stop buttons and a status line. Disabled
   until a file is loaded.
4. **Side-by-side graphs** — *Melodic graph* (left) and *Harmonic
   graph* (right) in a two-column row. Each panel has its settings
   bar **above** the graph: track picker + zoom controls + display
   options (color by pitch class, edge thickness, drag-pin mode,
   probability / pitch range filters). On viewports narrower than
   1100 px the two columns stack vertically so each graph stays
   legible.
5. **Sheet music** — real notation. MusicXML renders directly via
   OSMD; MIDI imports go through `buildSyntheticMusicXml` in
   `js/musicxml.js` to get a score (since MIDI carries no notation
   data), then a webmscore-powered render for professional-grade
   engraving.
6. **Summary** — note count, unique pitches, total transitions,
   self-loop count + share, pitch range, and **every transition
   sorted by probability** (not just the top 5).

### Melodic graph

- **Graph** — every unique pitch in the file is a node, every observed
  transition is a directed edge. Edge thickness is proportional to
  probability. Self-loops (A→A) get their own arc and a distinct amber
  label so they stand out.
- **Stats panel** — note count, unique pitches, total transitions,
  self-loop count + share, pitch range, **and every transition
  sorted by probability** (not just the top 5).
- **Per-node annotation** — every node is labeled with the pitch name
  (e.g. `C4`, or for quarter-tones the demo shows `A#↑3` / `D#↑4`
  which are the sharp-spelled enharmonic names for `B↓3` / `E↓4` —
  see "Quarter-tone naming" below) and the absolute frequency
  as a percentage of the whole piece (e.g. `12.25%`).
- **Per-edge annotation** — every transition label shows the
  conditional probability `P(target | source)` as a percentage.
  Self-loop labels are amber, regular edge labels are light grey; both
  are always visible (no hover required) with a dark stroke for
  contrast on any background.
- **Filter** — minimum probability, minimum/maximum pitch range. Color
  by pitch class on/off. Edge thickness on/off.
- **Drag** — drag any node to reposition. Default is REARRANGE mode
  (the graph resettles around your drag). Check the "Pin dragged
  nodes" box to switch to PIN mode (your drag stays put, the rest of
  the graph settles around it).
- **Zoom** — mouse wheel / pinch, or the Zoom in / Zoom out / Reset
  buttons.
- **Playback** — Tone.js PolySynth with real note durations
  (note_on → matching note_off) and multi-tempo support (a piece that
  changes tempo plays at the right speed throughout). Stop cancels
  scheduled future notes; Play after Stop re-runs the whole piece.
- **Sheet music** — OSMD renders the score as SVG inside the browser.
  Works for both MusicXML files (direct render) and MIDI files
  (synthesized from the parsed events; see
  `buildSyntheticMusicXml` in `js/musicxml.js`).

---

## How everything is calculated

This section documents every formula in the codebase so a reviewer can
verify the math without reading the source.

### Pitch identity: cents above C0

Every pitch in the app is a single number: **cents above C0** (a
MIDI-note-like quantity but with quarter-tone precision).

- `C0 = 0¢` (some use MIDI 12; we offset by 1200 so C-1 = −1200¢, C4 = 6000¢)
- `A4 = 6900¢` (440 Hz)
- 1 semitone = 100 cents; 1 octave = 1200 cents

Why cents and not MIDI bytes: cents are continuous. A MIDI byte is an
integer in [0, 127], so it can't represent a quarter-tone. By keeping
all internal data in cents (as floats) we preserve quarter-tones
exactly through parsing, transitions, stats, and Tone.js playback.

### Octave numbering (MusicXML convention)

`C4` is middle C (MIDI 60). The general formula is:

```
cents = (octave + 1) * 1200 + base_cents_from_C + alter * 100
```

where `base_cents_from_C` is the 12-entry `SHARP_CENTS_FROM_C` table
in `js/midi.js`:

```
C  →    0      F  →  500
C# →  100      F# →  600
D  →  200      G  →  700
D# →  300      G# →  800
E  →  400      A  →  900
                 A# → 1000
                 B  → 1100
```

`alter` is in semitones: `0` for natural, `1` for sharp, `-1` for flat,
`0.5` for half-sharp (quarter-tone up), `1.5` for sharp + half-sharp,
etc. So:

- `C4` (step=C, alter=0, oct=4) → `(4+1)*1200 + 0 + 0 = 6000`
- `C#4` (step=C, alter=1, oct=4) → `(4+1)*1200 + 0 + 100 = 6100`
- `A4` (step=A, alter=0, oct=4) → `(4+1)*1200 + 900 = 6900` (440 Hz)
- `A↑4` (step=A, alter=0.5, oct=4) → `(4+1)*1200 + 900 + 50 = 6950`

### Quarter-tone naming

There are 24 distinct pitch classes per octave (12 naturals/sharps
plus 12 half-sharps). Each is named `[step][#?]↑[N]` in the compact
form, e.g. `C↑4`, `D#↑4`, `F4`. The `↑` (Unicode U+2191) means
"half-sharp" — a quarter-tone sharper than the un-`↑` form.

The legacy long form is `C half-sharp 4` / `C half-flat 4`. It's
still accepted by the regex in `pitchOf()` (graph.js) for backwards
compatibility but the app emits only the short form.

**Enharmonic spelling gotcha (the demo specifically):** the shipped
`ya-tyra.mxl` (a piece using Arabic maqam quarter-tones) encodes
its accidentals as half-FLATS, so the source XML has elements like
`<step>B</step><alter>-0.5</alter><octave>3</octave>` for `B↓3`
(= 5850 cents) and `<step>E</step><alter>-0.5</alter><octave>4</octave>`
for `E↓4` (= 6350 cents). But `centsToPitch` reports them as `A#↑3`
and `D#↑4` — the SHARP-spelled enharmonic names — because it always
picks the closest note above (or at) the cents value, and 5850¢ is
50¢ *above* A#3 (5800¢) rather than 50¢ *below* B3 (5900¢). The two
spellings describe the same pitch; the app just consistently picks
the sharp form. The MIDI file demo has no quarter-tones (MIDI bytes
are 12-TET only).

Eighth-tones (alter=0.25, 0.75) round to the nearest quarter-tone
for display only — graph nodes, transitions, and stats are all
exact in cents.

### Display round-trip: `centsToStepAlterOctave`

To synthesize MusicXML from MIDI cents (so MIDI files can render
sheet music), the inverse of `stepAlterOctaveToCents` is needed. The
synth (`buildSyntheticMusicXml` in `js/musicxml.js`) calls
`centsToStepAlterOctave(cents)` for every note. This is critical to
get right because OSMD (the sheet-music renderer) crashes with
`undefined.toLowerCase()` if `<step>` contains a sharp — its
`pitchEnumValues` is `[C, D, E, F, G, A, B]` and the
`FundamentalNote` setter is `pitchEnumValues.indexOf(step)`. So the
function always returns a single letter for `step` and uses
`alter` for the sharp:

- `6100¢` → `{step: 'C', alter: 1, octave: 4}` (C#4, written as
  `<step>C</step><alter>1</alter><octave>4</octave>`)
- `6050¢` → `{step: 'C', alter: 0.5, octave: 4}` (C half-sharp 4)
- `6150¢` → `{step: 'C', alter: 1.5, octave: 4}` (C# half-sharp 4)
- `6900¢` → `{step: 'A', alter: 0, octave: 4}` (A4)

Rounding uses banker's rounding (round-half-to-even) at the
50-cent granularity, so `6025¢` rounds to `6000¢` and `6075¢` rounds
to `6100¢`.

### Transition probability

For every adjacent pair `(notes[i], notes[i+1])` in the playback-order
note sequence, we count:

```
count[(cur, nxt)] += 1
totals[cur]       += 1
```

Then `P(target | source) = count[(cur, nxt)] / totals[cur]`. This is
the empirical conditional probability — the fraction of times
`nxt` followed `cur` in this specific piece.

A **self-loop** is a transition where `target === source` (the same
note was played twice in a row). They're displayed as small arcs
above the node with amber labels (because they're easy to miss in a
dense graph if styled identically to regular edges).

### Node frequency (absolute percentage)

Distinct from the conditional transition probability. Every pitch's
absolute count is divided by the total number of notes:

```
frequency[pitch] = count_of(pitch) / total_notes
```

So if A4 is played 134 times in a 1094-note piece,
`frequency("A4") = 134/1094 ≈ 12.25%`. The label on each node shows
this as a percentage (e.g. `12.3%` for ≥1%, `0.34%` for sub-1%).
Hover any node for the full count + percentage: `A4 — 134 occurrences
(12.25% of piece)`.

The LAST note of the piece is included in the count (it has no
outgoing transition so it would be missed by a transition-only
counting approach). This was a real bug in an earlier round — fixed
in `a551c8c`.

### Pitch range

```
semitones = (max_cents - min_cents) / 100
```

Shown in the stats panel as e.g. `G#3 – D6 (29 semitones)`. For
quarter-tone ranges, the count may be a half-integer (e.g. `29.5`).

### Banker's rounding for eighth-tones

JavaScript's `Math.round(0.5)` rounds toward +infinity, which is
asymmetric: `Math.round(0.5) = 1` but `Math.round(-0.5) = 0`. For
quarter-tone naming this matters because `roundToNearest50(25)` would
round up to `50` (C half-sharp) but `roundToNearest50(-25)` would
round to `0` (B half-sharp of the octave below — different pitch).
The `roundToNearest50` helper in `js/midi.js` implements
round-half-to-even, so the two cases are consistent.

### Tick-to-seconds (multi-tempo)

`timeTicks` is in MIDI ticks (PPQ). To convert to seconds, we need
to know the tempo at that tick:

```
secondsPerTick = (1 / ticksPerQuarter) * (60 / tempoBPM)
```

For pieces with multiple tempos, `ticksToSecondsSegments` walks the
events in tick order, splitting into segments `[startTick, endTick)`
where the tempo is constant, and returns a function that picks the
right segment for any tick and computes the cumulative seconds
offset. This is what makes a piece that switches from 60 BPM to
120 BPM mid-song play at the correct relative speed for each
section.

The MusicXML parser collects tempo-change points from `<direction>`
elements (either `<sound tempo="...">` or
`<metronome><per-minute>...</per-minute></metronome>`) and stamps each
event with the active tempo in a second pass. The MIDI parser does
the same with `set-tempo` (meta-event 0x51) events.

### Audio frequency from cents

`Tone.js` takes a frequency in Hz. The conversion is the standard
equal-temperament formula:

```
freq = 440 * 2^((cents - 6900) / 1200)
```

(where 6900 = cents of A4, the 440 Hz reference). A C4 is 6000¢,
which is 9 semitones below A4, so `freq = 440 * 2^(-9/12) ≈ 261.63 Hz`.

### File detection (content sniffing)

The upload handler ignores the file extension and sniffs the first
few bytes:

| First bytes | Detected type |
|-------------|---------------|
| `MThd` (4D 54 68 64) | MIDI |
| `PK\x03\x04` (50 4B 03 04) | .mxl (ZIP) |
| `<?xml` or `<score-` | MusicXML |
| anything else | unknown, with a hint based on the extension |

This handles the common case of users renaming a `.musicxml` to
`.mid` by accident. The error message includes a hint about what
extension they probably meant.

### .mxl extraction

A `.mxl` file is a ZIP containing `META-INF/container.xml`, which
points to the rootfile via `full-path="..."`. The vendored `fflate`
library unzips; the rootfile content is decoded as UTF-8 and
parsed by the same `js/musicxml.js` parser used for plain
`.musicxml`.

### Sheet music from MIDI

MIDI doesn't carry notation data — no stem direction, beaming,
articulations, dynamics, key signature, time signature, just timed
note on/off events. To still give the user a sheet-music view, the
app takes **two** routes, picking the best one available:

**Route 1 — webmscore (default).** [LibreScore's
webmscore](https://github.com/LibreScore/webmscore) is MuseScore 1.x
compiled to WebAssembly. It does a real MIDI → MusicXML conversion
with proper engraving: beam grouping, voice separation, slurs,
articulations, dynamic markings, key and time signatures inferred
from the MIDI, and even reads tempo/text meta events into a
`<work><work-title>` / `<identification><creator>` block. The Bach
Allemande demo, for example, gets titled "Six Sonatas and Partitas
for Solo Violin" with composer "Johann Sebastian Bach (1685-1750)"
and tempo "♩ = 220" automatically. The 9 MB WASM bundle is
vendored under `vendor/webmscore/` (lazy-loaded only when a MIDI
import happens), so MXL-only users never pay the cost.

**Route 2 — hand-rolled synth (fallback).** If webmscore fails to
load, fails to convert, or the worker dies, the bridge returns
`null` and `app.js` falls back to `buildSyntheticMusicXml()` in
`js/musicxml.js`. The synth:

1. Picks the track with the most `note_on` events (handles MIDI
   files with melody + accompaniment + drums — we render the
   melody, not the drums).
2. Reads the FF 58 time-signature meta event from the MIDI (or
   defaults to 4/4).
3. Pairs each `note_on` with its matching `note_off` to get real
   durations.
4. Quantizes start times to the 16th-note grid (absorbs human
   timing jitter and dedupes re-attacks at the same position).
5. Groups notes that share a quantized start into one MusicXML
   chord — one `<note>` plus N-1 `<chord/>` siblings stacked
   vertically at the same rhythmic position.
6. Splits cross-measure durations with ties (`<tie type="start"/>`
   in the fitting measure, `<tie type="stop"/>` in the next) rather
   than the carryover hack that was the source of every "jammed
   notes / wrong values" bug report.
7. Snaps each note's duration to the closest standard duration
   (whole/half/quarter/eighth/16th) for the `<type>` element,
   using the actual tick count for `<duration>`.

The output is a complete MusicXML 4.0 document with
`<work>`, `<identification>`, `<defaults>` (scaling + page-layout),
`<part-list>`, and the part itself. The `<defaults>` block is
required by OSMD — without it OSMD crashes with
`undefined.toLowerCase()` when its measure-layout code reads
attributes that don't exist.

### Force-directed graph layout

D3's `forceSimulation` with these forces:

- `forceLink` — pulls connected nodes toward each other
  (distance 80). Edges are the transition pairs.
- `forceManyBody` — strong repulsion between all nodes
  (charge strength −180). Keeps the layout spread out.
- `forceCenter` — pulls everything toward the SVG center.
  Updated on every tick so resize/zoom keeps the graph centered.
- `forceCollide` — radius 28 around each node to prevent overlap
  (slightly larger than the node circle radius 18 to leave
  breathing room for labels).

The simulation runs with `alpha = 0.9` (high energy) on every
rebuild, then cools down as ticks fire. Edges are quadratic
Bézier curves with a 15px perpendicular bow to make the
direction of the arrow unambiguous. The endpoint is shrunk by
`NODE_R + 4 = 22px` so the arrow head sits just outside the
target node, not on top of it.

### Edge color & thickness

Default edge color: `#666` at 0.55 opacity. On hover: `#fff` at
1.0 opacity (and the arrow marker swaps to the white `arrow-hover`
marker). Thickness scales linearly with probability:
`0.5 + value * 5` (so a 100% edge is 5.5px, a 0% edge is 0.5px
which is still visible). Toggle off to use a flat 1.5px for all.

---

## Supported formats

- `.mid`, `.midi` — Standard MIDI. Parsed by `js/midi.js` directly
  in the browser (no library, no server). Sheet music is synthesized
  from the parsed events.
- `.musicxml`, `.xml` — MusicXML 3.1 / 4.0 partwise and timewise.
  Parsed by `js/musicxml.js` using the browser's built-in
  `DOMParser`. Sheet music rendered by OSMD.
- `.mxl` — Compressed MusicXML (a ZIP with
  `META-INF/container.xml`). Unzipped in-browser via the vendored
  `fflate` library; the rootfile is read and routed through the same
  `js/musicxml.js` parser. Sheet music rendered by OSMD.

Both formats produce the same event shape internally, so transitions,
stats, graph, and playback all work identically regardless of source.

---

## Controls

- **Choose File** — upload any supported file. Drag-and-drop is
  supported in most browsers.
- **Load demo (Bach Allemande, .mid)** — J.S. Bach's Allemande from
  Violin Partita No. 2 in D minor, BWV 1004, in standard 12-TET MIDI
  (`vp2-1all.mid`, 1094 notes, 30 unique pitches, 193 transitions).
- **Load demo (ya-tyra, .mxl)** — "يا طيرة طيري يا حمامة" (O little
  bird, fly O pigeon), a traditional Arabic maqam piece in compressed
  MusicXML (`ya-tyra.mxl`, 243 notes, 8 unique pitches, 28 transitions,
  2 quarter-tones — `A#↑3` and `D#↑4` in the app's sharp-spelled
  naming; the source XML actually has them as `B↓3` and `E↓4`).
  Demonstrates .mxl (zip) extraction, quarter-tone rendering, and
  the synthetic MusicXML fallback that makes sheet music work for any
  file type.
- **▶ Play** / **■ Stop** — playback. Stop cancels scheduled
  future notes, releases active voices, and clears the
  per-playback state so the next Play works correctly.
- **Min probability slider** — hides transitions below the
  threshold. Range 0–100%.
- **Min/Max pitch sliders** — hides notes outside the pitch
  range. Range C-1 (0¢) to C8 (10800¢), step 50¢ (one
  quarter-tone).
- **Color by pitch class** — 24 distinct colors (one per
  quarter-tone class within an octave, generated in HSL space
  at 15° intervals). Uncheck to use a single accent color for
  all nodes.
- **Edge thickness by probability** — edges scale with their
  probability. Uncheck for a uniform thickness.
- **Pin dragged nodes** — default is REARRANGE (drag, release,
  the graph settles back). Check to switch to PIN (your drag
  sticks; the rest of the graph settles around it).
- **Zoom in / Zoom out / Reset** — viewport transforms via
  D3 zoom.

---

## Files

```
index.html               # entry point — upload + stats + graph + playback + sheet UI
css/style.css            # all styles
js/midi.js               # .mid parser, transition graph, stats, cents ↔ pitch (browser + node)
js/musicxml.js           # MusicXML parser + synth (browser + node via @xmldom/xmldom)
js/graph.js              # D3 force-directed rendering
js/playback.js           # Tone.js playback (real durations, multi-tempo, replay-safe)
js/sheet.js              # OSMD sheet music rendering
js/app.js                # glue layer — wires the modules together
examples/
  vp2-1all.mid            # demo file — Bach Allemande BWV 1004, MIDI form (12-TET, 1094 notes)
  ya-tyra.mxl             # demo file — Arabic maqam "ya tayra", compressed MusicXML (with quarter-tones)
scripts/
  serve-nocache.py        # local dev server with no-cache headers (for development)
tests/
  midi.test.js            # node smoke tests for midi.js (parsing, transitions, stats, rounding)
  musicxml.test.js        # node smoke tests for musicxml.js (parsing, quarter-tones, synth)
netlify.toml              # `publish = "."` and content-type headers for .mxl
package.json              # devDependencies only (@xmldom/xmldom + fflate for tests)
```

## Tests

```sh
npm install              # one-time: gets @xmldom/xmldom + fflate for tests
node tests/midi.test.js
node tests/musicxml.test.js
node tests/harmonic.test.js
node tests/playback.test.js
```

134 tests covering parsing, transitions, stats, multi-tempo timing
(MIDI + MusicXML), banker's-rounding for eighth-tones, chord
detection across template / neutral-triad / literal-spelling paths,
playback schedule timing (wall-clock vs relative seconds — the bug
behind an earlier "chord glow jumps" report), .mxl extraction,
content-sniffing file routing, the synth carryover, and the real
example files.

## Limits

- 16 MB upload cap (client-side check).
- MIDI format 0 and 1 (which is what virtually every `.mid` you'll
  find is).
- SMPTE-timed MIDI files are rejected (extremely rare).
- Multi-tempo playback works correctly: MIDI via tempo-change
  meta-events; MusicXML via `<direction>` elements processed in
  document order within each measure.
- Quarter-tones (alter = ±0.5, ±1.5) are preserved exactly through
  parsing, transitions, stats, and Tone.js playback.
  Eighth-tones (alter = ±0.25, ±0.75) round to the nearest
  quarter-tone for display only — graph nodes, transitions, and
  stats are all exact in cents.
- MusicXML score-timewise is supported (flattened to partwise
  internally). Complex features like grace notes, slurs, beams,
  and ties are parsed at the note level but not rendered with
  their full expressive semantics — see the per-file caveats in
  `parseMusicXml` in `js/musicxml.js`.

## License

The project source code (everything under `js/`, `css/`, `index.html`,
`tests/`, and `scripts/`) is MIT — see [LICENSE](LICENSE).

The vendored [webmscore](https://github.com/LibreScore/webmscore)
bundle under `vendor/webmscore/` is **GPL v3**, derived from
MuseScore 1.x. It is dynamically loaded only when a user imports a
MIDI file; the rest of the app (the transition graph, the parser,
the MusicXML synth fallback, the playback engine) is MIT. Any
combined work that exercises the MIDI-import path inherits GPL v3
obligations. To use midi-graph in a setting where GPL v3 is
incompatible (proprietary distribution, app-store deployment,
etc.), remove the `vendor/webmscore/` directory and delete the
`<script type="module" src="js/webmscore-bridge.js">` tag from
`index.html` — the hand-rolled synth in `js/musicxml.js` will then
take over automatically.
