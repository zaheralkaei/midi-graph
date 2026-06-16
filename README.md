# midi-graph

Upload a MIDI file. Get a visual map of which notes follow which. Hear it played back in the browser.

The app builds a Markov-style transition graph from the note sequence (note A → note B, with the empirical probability of that transition) and renders it as a force-directed D3 graph you can drag, filter, and zoom. Stats panel shows total notes, unique pitches, top transitions, self-loop rate, and pitch range. Playback is real audio via Tone.js — the browser can't decode `.mid` natively, so the file is fetched and replayed note-by-note.

## Run

```
pip install -r requirements.txt
python app.py
```

Then open http://localhost:5000 and upload a `.mid` file.

## What you get

- **Graph** — every unique pitch in the file is a node, every observed transition is a directed edge. Edge thickness is proportional to probability. Self-loops (A→A) get their own arc.
- **Stats** — note count, unique pitches, total transitions, self-loop count + share, pitch range, top 5 transitions.
- **Filter** — minimum probability, minimum/maximum pitch range. Pitch-class color coding on/off. Edge thickness on/off.
- **Playback** — Tone.js PolySynth, all notes at the original timing.

## Controls

- Drag any node to reposition it
- Mouse wheel / pinch to zoom
- Zoom in / Zoom out / Reset buttons
- Min probability slider hides weak edges
- Min/max pitch sliders hide out-of-range notes
- "Color by pitch class" toggle: 12 distinct colors per chromatic class, or single accent color

## Files

```
app.py                # Flask server
midi_processing.py    # MIDI parsing, transition graph, stats
templates/
  upload.html         # All UI: upload + stats + graph + playback
requirements.txt      # flask, mido, networkx
```

## Limits

- 16 MB upload cap
- `.mid` and `.midi` extensions only
- The browser-side MIDI parser handles format 0 and 1 (which is what virtually every `.mid` you'll find is)
- Playback uses a single global tempo — multi-tempo pieces work for analysis but play back at the first tempo

## License

MIT. See [LICENSE](LICENSE).
