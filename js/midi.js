// midi.js — parse a .mid file (format 0/1) and build a note→next-note transition graph.
//
// Pure functions, no DOM, no Tone.js. Imports cleanly into a node test runner.
//
// Public API:
//   parseMidi(bytes)                              → { events, ticksPerQuarter }
//       events = [{ timeTicks, type, note, vel?, tempoBPM }, ...]
//       timeTicks is absolute delta-tick time from track start.
//       tempoBPM is the tempo ACTIVE at that event (so callers can convert to seconds
//       correctly even with multiple tempo changes).
//       type is 'on' (velocity>0) or 'off' (note-off OR note-on vel=0).
//
//   notesFromEvents(events)                       → number[]
//       Flat playback-order list of note numbers (note_on with vel>0 only).
//       Concatenates all tracks, mirroring the Python read_midi_file() behavior.
//
//   buildTransitionGraph(notes)                   → { nodes, links }
//       nodes: [{id}] sorted by pitch (D3-friendly).
//       links: [{source, target, value}] where value is the empirical probability.
//
//   computeStats(notes, graph)                    → { ... }
//       note_count, unique_note_count, unique_notes, transition_count,
//       top_transitions, self_loop_count, self_loop_share, pitch_range.
//
//   midiToPitch(noteNumber)                       → "C4"
//   pitchClass(noteNumber)                        → "C"
//
//   ticksToSeconds(timeTicks, tempoBPM, ticksPerQuarter)
//       Convert a single tick time to seconds using the given tempo.
//       Callers handling multi-tempo sequences must walk events in order and
//       re-base when tempoBPM changes — see ticksToSecondsSegments() helper.

// Sharp names (C# not Db) — standard music-theory convention. Pieces in
// sharp keys (G major, D major, etc.) render naturally; flat-key pieces
// (F major, Bb major) get the sharp spelling of their chromatic neighbors.
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToPitch(n) {
  return NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
}

function pitchClass(n) {
  return NOTE_NAMES[n % 12];
}

// ---------------------------------------------------------------------------
// Variable-length quantity (VLQ) — MIDI's compact integer encoding.
// Used for delta-times and for meta-event payload lengths.
// ---------------------------------------------------------------------------
function readVarLen(bytes, offset) {
  let value = 0;
  let byte;
  do {
    if (offset >= bytes.length) {
      throw new Error(`VLQ read past end at offset ${offset}`);
    }
    byte = bytes[offset++];
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return [value, offset];
}

// ---------------------------------------------------------------------------
// parseMidi: full format-0/1 parser. Emits BOTH note_on and note_off so
// downstream playback can compute real durations. Each event carries the
// tempoBPM that was active when the event happened — the multi-tempo fix.
// ---------------------------------------------------------------------------
function parseMidi(bytes) {
  // Header chunk: "MThd" + length(4) + format(2) + tracks(2) + division(2)
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (header !== 'MThd') {
    throw new Error('Not a MIDI file (missing MThd header)');
  }
  const headerLen = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7];
  if (headerLen !== 6) {
    throw new Error(`Unexpected MThd length ${headerLen}`);
  }
  const format = (bytes[8] << 8) | bytes[9];
  if (format !== 0 && format !== 1) {
    throw new Error(`Unsupported MIDI format ${format} (only 0 and 1)`);
  }
  const numTracks = (bytes[10] << 8) | bytes[11];
  // Division: top bit clear → ticks per quarter note. Top bit set → SMPTE,
  // which we don't bother with (extremely rare for downloaded .mid files).
  const divisionWord = (bytes[12] << 8) | bytes[13];
  if (divisionWord & 0x8000) {
    throw new Error('SMPTE-timed MIDI files are not supported');
  }
  const ticksPerQuarter = divisionWord;

  // Walk the track chunks.
  let pos = 8 + headerLen;
  const tracks = [];
  for (let t = 0; t < numTracks; t++) {
    const tag = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    if (tag !== 'MTrk') {
      throw new Error(`Bad track header at byte ${pos}: expected MTrk, got ${tag}`);
    }
    const trackLen = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7];
    pos += 8;
    tracks.push(bytes.slice(pos, pos + trackLen));
    pos += trackLen;
  }

  // Walk all tracks, merging events in track order then by absolute time
  // so playback-scheduling matches what most sequencers would do.
  const events = [];
  let tempoBPM = 120;          // MIDI default until a set-tempo meta arrives
  let microsPerQuarter = 500000;
  for (const track of tracks) {
    let p = 0;
    let t = 0;
    let runningStatus = 0;
    while (p < track.length) {
      let delta;
      [delta, p] = readVarLen(track, p);
      t += delta;
      let status = track[p];
      if (status < 0x80) {
        // Running status: data byte reuses last channel-voice status.
        status = runningStatus;
      } else {
        p++;
        if (status >= 0x80 && status < 0xf0) runningStatus = status;
      }
      if (status === 0xff) {
        // Meta event. We only care about set-tempo (0x51) for playback timing.
        const metaType = track[p++];
        let len;
        [len, p] = readVarLen(track, p);
        if (metaType === 0x51 && len === 3) {
          microsPerQuarter = (track[p] << 16) | (track[p + 1] << 8) | track[p + 2];
          tempoBPM = Math.round(60_000_000 / microsPerQuarter);
        }
        p += len;
      } else if (status === 0xf0 || status === 0xf7) {
        // System exclusive — skip its VLQ-length payload.
        let len;
        [len, p] = readVarLen(track, p);
        p += len;
      } else {
        const hi = status & 0xf0;
        if (hi === 0x90) {
          const note = track[p++];
          const vel = track[p++];
          if (vel > 0) {
            events.push({ timeTicks: t, type: 'on', note, vel, tempoBPM });
          } else {
            // note_on with velocity 0 is the standard "note_off" shorthand.
            events.push({ timeTicks: t, type: 'off', note, tempoBPM });
          }
        } else if (hi === 0x80) {
          const note = track[p++];
          const vel = track[p++];
          events.push({ timeTicks: t, type: 'off', note, vel, tempoBPM });
        } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
          // Aftertouch / CC / pitch-bend — 2 data bytes.
          p += 2;
        } else if (hi === 0xc0 || hi === 0xd0) {
          // Program change / channel pressure — 1 data byte.
          p += 1;
        } else {
          // Unknown status — bail rather than silently corrupting the stream.
          throw new Error(`Unknown MIDI status byte 0x${status.toString(16)} at track offset ${p - 1}`);
        }
      }
    }
  }

  // Sort by absolute tick time so multi-track playback is correctly interleaved.
  events.sort((a, b) => a.timeTicks - b.timeTicks);
  return { events, ticksPerQuarter };
}

// ---------------------------------------------------------------------------
// notesFromEvents: the playback-order sequence of struck notes. Mirrors the
// Python read_midi_file() behavior (note_on vel>0 from any track, in the order
// the parser merged them). Used to build the transition graph.
// ---------------------------------------------------------------------------
function notesFromEvents(events) {
  const out = [];
  for (const ev of events) {
    if (ev.type === 'on') out.push(ev.note);
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildTransitionGraph: count note→next-note transitions per source pitch,
// normalize per source, emit D3 nodes + links.
// ---------------------------------------------------------------------------
function buildTransitionGraph(notes) {
  const counts = new Map();   // cur → Map(nxt → count)
  const totals = new Map();
  for (let i = 0; i < notes.length - 1; i++) {
    const cur = notes[i];
    const nxt = notes[i + 1];
    if (!counts.has(cur)) counts.set(cur, new Map());
    const inner = counts.get(cur);
    inner.set(nxt, (inner.get(nxt) || 0) + 1);
    totals.set(cur, (totals.get(cur) || 0) + 1);
  }

  const nodeSet = new Set();
  const links = [];
  for (const [cur, inner] of counts) {
    const total = totals.get(cur);
    const curName = midiToPitch(cur);
    nodeSet.add(curName);
    for (const [nxt, count] of inner) {
      const nxtName = midiToPitch(nxt);
      nodeSet.add(nxtName);
      links.push({ source: curName, target: nxtName, value: count / total });
    }
  }
  const nodes = Array.from(nodeSet).sort().map(id => ({ id }));
  return { nodes, links };
}

// ---------------------------------------------------------------------------
// computeStats: note counts, self-loops, top transitions, pitch range.
// `graph` is the output of buildTransitionGraph above.
// ---------------------------------------------------------------------------
function computeStats(notes, graph) {
  const uniqueNotes = Array.from(new Set(notes)).sort((a, b) => a - b);
  const uniqueNames = uniqueNotes.map(midiToPitch);

  // Flatten links → ranked triples (from, to, probability).
  const ranked = graph.links.map(l => [l.source, l.target, l.value]);
  ranked.sort((a, b) => b[2] - a[2]);

  const selfLoops = ranked.filter(([from, to]) => from === to).length;
  const transitionCount = ranked.length;
  const selfLoopShare = transitionCount ? selfLoops / transitionCount : 0;

  let rangeStr = '—';
  if (uniqueNotes.length) {
    const lo = uniqueNotes[0];
    const hi = uniqueNotes[uniqueNotes.length - 1];
    rangeStr = `${midiToPitch(lo)} – ${midiToPitch(hi)} (${hi - lo} semitones)`;
  }

  return {
    note_count: notes.length,
    unique_note_count: uniqueNotes.length,
    unique_notes: uniqueNames,
    transition_count: transitionCount,
    top_transitions: ranked.slice(0, 5).map(([from, to, prob]) => ({
      from,
      to,
      probability: Math.round(prob * 10000) / 10000,
    })),
    self_loop_count: selfLoops,
    self_loop_share: Math.round(selfLoopShare * 10000) / 10000,
    pitch_range: rangeStr,
  };
}

// ---------------------------------------------------------------------------
// Timing helpers for playback. Two strategies:
//   1. Single global tempo (simple): use the first tempoBPM from the events.
//   2. Multi-tempo (correct): walk events, re-base the running offset whenever
//      tempoBPM changes. Use this for any piece that may change tempo.
//
// ticksToSecondsSegments returns [{ startTick, endTick, secondsPerTick }] —
// each segment covers a contiguous range of ticks at one tempo. Convert a
// tick time by finding its segment and computing (t - startTick) * secondsPerTick
// + segmentStartSeconds (the running sum of previous segments).
// ---------------------------------------------------------------------------
function ticksToSeconds(timeTicks, tempoBPM, ticksPerQuarter) {
  // 1 quarter = 60/tempoBPM seconds. 1 tick = that / ticksPerQuarter.
  return (timeTicks / ticksPerQuarter) * (60 / tempoBPM);
}

function ticksToSecondsSegments(events, ticksPerQuarter) {
  const segments = [];
  let currentTempo = null;
  let segStart = 0;
  for (const ev of events) {
    if (ev.tempoBPM !== currentTempo) {
      if (currentTempo !== null) {
        segments.push({
          startTick: segStart,
          endTick: ev.timeTicks,
          secondsPerTick: (1 / ticksPerQuarter) * (60 / currentTempo),
        });
      }
      segStart = ev.timeTicks;
      currentTempo = ev.tempoBPM;
    }
  }
  if (currentTempo !== null) {
    const lastTick = events.length ? events[events.length - 1].timeTicks : 0;
    segments.push({
      startTick: segStart,
      endTick: lastTick,
      secondsPerTick: (1 / ticksPerQuarter) * (60 / currentTempo),
    });
  }

  // Convert tick time to seconds via the segment table.
  let segmentStarts = [];
  let acc = 0;
  for (const seg of segments) {
    segmentStarts.push(acc);
    acc += (seg.endTick - seg.startTick) * seg.secondsPerTick;
  }
  return function tickToSec(tick) {
    for (let i = segments.length - 1; i >= 0; i--) {
      if (tick >= segments[i].startTick) {
        return segmentStarts[i] + (tick - segments[i].startTick) * segments[i].secondsPerTick;
      }
    }
    return 0;
  };
}

// ---------------------------------------------------------------------------
// analyzeMidi: convenience entrypoint matching the old Python API surface.
// Returns { graph, stats } given a Uint8Array of .mid bytes.
// ---------------------------------------------------------------------------
function analyzeMidi(bytes) {
  const { events, ticksPerQuarter } = parseMidi(bytes);
  const notes = notesFromEvents(events);
  const graph = buildTransitionGraph(notes);
  const stats = computeStats(notes, graph);
  return { graph, stats, events, ticksPerQuarter };
}

// ---------------------------------------------------------------------------
// Exports — CommonJS for node tests, globals for browser <script> tag.
// ---------------------------------------------------------------------------
const api = {
  NOTE_NAMES,
  midiToPitch,
  pitchClass,
  readVarLen,
  parseMidi,
  notesFromEvents,
  buildTransitionGraph,
  computeStats,
  ticksToSeconds,
  ticksToSecondsSegments,
  analyzeMidi,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.MidiGraph = api;
}