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
//       note is in CENTS above C0 (C4 = 6000). Float, supports quarter-tones.
//
//   notesFromEvents(events)                       → number[]
//       Flat playback-order list of note cents values.
//
//   buildTransitionGraph(notes)                   → { nodes, links }
//       nodes: [{id}] sorted by pitch (D3-friendly). Quarter-tones get their own node.
//       links: [{source, target, value}] where value is the empirical probability.
//
//   computeStats(notes, graph)                    → { ... }
//       note_count, unique_note_count, unique_notes, transition_count,
//       all_transitions, self_loop_count, self_loop_share, pitch_range.
//
//   centsToPitch(cents)                           → "C4" or "C↑4" / "D#↑4"
//   stepAlterOctaveToCents(step, alter, octave)   → number (e.g. C half-sharp, 4 → 6050)
//   pitchClass(cents)                             → "C" / "C#" / "C↑"
//
//   ticksToSeconds(timeTicks, tempoBPM, ticksPerQuarter)
//       Convert a single tick time to seconds using the given tempo.
//       Callers handling multi-tempo sequences must walk events in order and
//       re-base when tempoBPM changes — see ticksToSecondsSegments() helper.

// ---------------------------------------------------------------------------
// Pitch identity: cents above C0. C4 = 6000. Quarter-tones are exact floats.
// Internal events carry `note` in cents, not as MIDI int. This means a C
// quarter-sharp (alter=0.5, octave=4) is exactly 6050.0 and stays distinct
// from C#4 (6100.0) all the way through transitions, stats, and playback.
// ---------------------------------------------------------------------------

// Cents from C within one octave for each natural / sharp note (12-TET).
const SHARP_CENTS_FROM_C = {
  C: 0, 'C#': 100, D: 200, 'D#': 300, E: 400, F: 500,
  'F#': 600, G: 700, 'G#': 800, A: 900, 'A#': 1000, B: 1100,
};

// Display names for the 24 quarter-tones within an octave. We name every
// half-tone as "[lower note]↑" (sharp-going-up convention). The compact "↑"
// symbol (Unicode U+2191) is shorter than "half-sharp" and is unambiguous
// in a quarter-tone context — quarter-tones in Arabic-music / Turkish-music
// notation use ↑/↓ for raised/lower alterations respectively. The
// alternative "half-flat" spelling is equivalent but harder to scan
// visually; we don't emit it but the parser still accepts it as input.
const QUARTER_TONE_NAMES = [
  { cents:    0, name: 'C' },
  { cents:   50, name: 'C↑' },
  { cents:  100, name: 'C#' },
  { cents:  150, name: 'C#↑' },
  { cents:  200, name: 'D' },
  { cents:  250, name: 'D↑' },
  { cents:  300, name: 'D#' },
  { cents:  350, name: 'D#↑' },
  { cents:  400, name: 'E' },
  { cents:  450, name: 'E↑' },
  { cents:  500, name: 'F' },
  { cents:  550, name: 'F↑' },
  { cents:  600, name: 'F#' },
  { cents:  650, name: 'F#↑' },
  { cents:  700, name: 'G' },
  { cents:  750, name: 'G↑' },
  { cents:  800, name: 'G#' },
  { cents:  850, name: 'G#↑' },
  { cents:  900, name: 'A' },
  { cents:  950, name: 'A↑' },
  { cents: 1000, name: 'A#' },
  { cents: 1050, name: 'A#↑' },
  { cents: 1100, name: 'B' },
  { cents: 1150, name: 'B↑' },
];

// Quarter-tone FLAT spelling. The "next LETTER" rule: at each
// quarter-tone boundary, the flat-spelled form is the next LETTER
// (not the next semitone) lowered by 50¢. This is how Arabic-maqam
// / microtonal theory names these pitches — letter-based, not
// semitone-based. Examples:
//   6350¢ = D#↑  (sharp form, letter D, alter +1.5)
//         = E half-flat  (flat form, letter E, alter -0.5)
//   because E is the next LETTER after D, not the next semitone.
//   The "next letter" of D# is E (skipping D-natural since D# is
//   already an altered form of D). The "next letter" of D is also E.
//
// This rule produces musically meaningful names that match how
// maqam theorists and musicians actually think about these pitches:
//   E half-flat = "neutral 3rd" of C (always the letter E, not D#)
//   D half-flat = "neutral 2nd" of C (always the letter D)
//   B half-flat = "neutral 2nd" of A (always the letter B)
//
// The IMPORTANT consequence: in a chord or scale that already
// contains D, the quarter-tone pitch 250¢ is named E half-flat
// (not D# half-flat) because E is the next LETTER after D. The two
// spellings are enharmonically equivalent (both 250¢) but E
// half-flat matches the maqam naming convention. The user pointed
// this out explicitly during the audit follow-up.
//
// Sharp form   Flat form (letter, alter)
//   50  C↑      D,  -0.5
//  150  C#↑     D,  -0.5
//  250  D↑      E,  -0.5
//  350  D#↑     E,  -0.5
//  450  E↑      F,  -0.5
//  550  F↑      G,  -0.5
//  650  F#↑     G,  -0.5
//  750  G↑      A,  -0.5
//  850  G#↑     A,  -0.5
//  950  A↑      B,  -0.5
// 1050  A#↑     B,  -0.5
// 1150  B↑      C,  -0.5
const QUARTER_TONE_FLAT_FORM = {
   50: { step: 'D',  alter: -0.5 },
  150: { step: 'D',  alter: -0.5 },
  250: { step: 'E',  alter: -0.5 },
  350: { step: 'E',  alter: -0.5 },
  450: { step: 'F',  alter: -0.5 },
  550: { step: 'G',  alter: -0.5 },
  650: { step: 'G',  alter: -0.5 },
  750: { step: 'A',  alter: -0.5 },
  850: { step: 'A',  alter: -0.5 },
  950: { step: 'B',  alter: -0.5 },
 1050: { step: 'B',  alter: -0.5 },
 1150: { step: 'C',  alter: -0.5 },
};

// step+alter+octave → cents above C0. alter is in semitones (0, 0.5, 1, 1.5, ...).
// Negative alter is also supported (e.g. alter=-0.5 = quarter-flat of the
// note above; same as half-sharp of the note below).
//
// Eighth-tone precision: stepAlterOctaveToCents accepts alter=0.25 / 0.75 and
// produces exact cents (25, 75). However, centsToPitch rounds to the nearest
// quarter-tone (50 cents) for display purposes — eighth-tones appear as their
// nearest quarter-tone. If you need exact eighth-tone display, the naming layer
// needs a 48-entry table; for now quarter-tone is the highest resolution the
// rest of the pipeline supports.
function stepAlterOctaveToCents(step, alter, octave) {
  const base = SHARP_CENTS_FROM_C[step];
  if (base === undefined) return null;
  // MusicXML octave numbering: middle C (MIDI 60) is octave 4.
  // C0 = MIDI 12 = cents 0; so (octave+1)*1200 + offset, where offset is
  // step cents + alter cents (alter is in semitones, so × 100).
  const a = alter == null ? 0 : alter;
  return (octave + 1) * 1200 + base + Math.round(a * 100);
}

// Inverse of stepAlterOctaveToCents — for synthesizing MusicXML from MIDI
// notes so we can render sheet music for .mid files. Uses the 24-entry
// QUARTER_TONE_NAMES table so quarter-tones round-trip exactly:
//   6000  → ('C',  0,   4)
//   6050  → ('D', -0.5, 4)   ← FLAT form (next letter)
//   6100  → ('C#', 0,   4)
//   6150  → ('D', -0.5, 4)   ← FLAT form
//   6250  → ('E', -0.5, 4)   ← FLAT form (next letter after D)
//   6350  → ('E', -0.5, 4)   ← FLAT form (next letter after D#)
// Eighth-tones (e.g. 6025) round to the nearest quarter-tone.
//
// At quarter-tone boundaries the function returns the FLAT-spelled
// enharmonic (E half-flat for 6350¢) using the "next LETTER" rule —
// see QUARTER_TONE_FLAT_FORM and the comment block on it.
function centsToStepAlterOctave(cents) {
  if (cents == null || !isFinite(cents) || cents < 0) return null;
  // octave = floor(cents / 1200) - 1, matching centsToPitch.
  const octave = Math.floor(cents / 1200) - 1;
  const withinOctave = cents - (octave + 1) * 1200;
  const rounded = roundToNearest50(withinOctave);
  const match = QUARTER_TONE_NAMES.find(t => t.cents === rounded);
  if (!match) return null;
  // Quarter-tone enharmonic preference: at every quarter-tone boundary
  // (e.g. 6350¢), we prefer the FLAT-spelled enharmonic (E half-flat) over
  // the SHARP-spelled one (D#↑) because Arabic-maqam / microtonal theory
  // names these pitches by their neutral-interval role (E half-flat is
  // the "neutral third" of C). See QUARTER_TONE_FLAT_FORM above.
  if (QUARTER_TONE_FLAT_FORM.hasOwnProperty(rounded)) {
    const flat = QUARTER_TONE_FLAT_FORM[rounded];
    // The B↑ / C half-flat boundary (within-octave 1150) is special: the
    // flat form puts the pitch in the NEXT octave (C half-flat 5 is
    // 7150¢, but 7150¢ is also 50¢ above B4). We prefer the higher
    // octave for the flat form because it reads as "the start of the
    // next octave" rather than "the end of the previous one" — which
    // is the convention in maqam/microtonal theory.
    let outOctave = octave;
    if (rounded === 1150) outOctave = octave + 1;
    return { step: flat.step, alter: flat.alter, octave: outOctave };
  }
  // Decompose match.name → (step, alter) for the sharp form. Names are:
  //   'C'    → step='C',  alter=0
  //   'C#'   → step='C',  alter=1    (full sharp)
  const hasSharp = match.name.endsWith('#');
  if (hasSharp) {
    return { step: match.name.slice(0, -1), alter: 1, octave };
  }
  return { step: match.name, alter: 0, octave };
}

// Round to nearest 50 cents using banker's rounding (round-half-to-even).
  // JavaScript's Math.round rounds .5 toward +infinity (asymmetric) — e.g. 25¢
  // rounds UP to 50¢ ("C half-sharp"), but -25¢ rounds toward zero to 0¢
  // ("B half-sharp of the octave below"). With banker's rounding, 25¢ rounds
  // to the even multiple (0¢), matching the -25¢ case. Quarter-tones are exact
  // at multiples of 50; anything else (e.g. 25-cent eighth-tones from
  // non-standard alters) rounds to the nearest quarter-tone. This is
  // intentional — we name by cents-to-nearest-50.
  function roundToNearest50(c) {
    // Banker's rounding: divide, round to nearest integer (with halves to even),
    // scale back. Math.round(0.5) = 1 in JS, but Math.round(-0.5) = 0, so to
    // get half-to-even we explicitly handle the .5 case.
    const divided = c / 50;
    const floor = Math.floor(divided);
    const diff = divided - floor;
    if (Math.abs(diff - 0.5) < 1e-9) {
      // Exactly on .5 — round to even.
      const floorIsEven = Math.abs(floor % 2) < 1e-9;
      return (floorIsEven ? floor : floor + 1) * 50;
    }
    return Math.round(divided) * 50;
  }

  // cents → display name like "C4", "C#4", "E half-flat 4" or
  // "F#↑4" (the half-sharp case where there's no flat enharmonic).
  // Quarter-tone boundaries use the flat-spelled enharmonic
  // (E half-flat not D#↑) so the display matches the rest of the
  // app's flat-spelled convention. Pure 12-TET pitches keep their
  // canonical names.
  function centsToPitch(cents) {
    if (cents == null || !isFinite(cents)) return '?';
    if (cents < 0) return '?';
    const sao = centsToStepAlterOctave(cents);
    if (!sao) return `?${cents}`;
    let name = sao.step;
    if (sao.alter === 1) name += '#';
    else if (sao.alter === -1) name += 'b';
    else if (sao.alter === 0.5) name += '\u2191';
    else if (sao.alter === -0.5) name += ' half-flat';
    return name + sao.octave;
  }

  // cents → just the pitch-class part (no octave). Used for the 24-class color scale.
  function pitchClass(cents) {
    if (cents == null || !isFinite(cents)) return '?';
    const withinOctave = ((cents % 1200) + 1200) % 1200;  // handle negatives
    const rounded = roundToNearest50(withinOctave);
    const match = QUARTER_TONE_NAMES.find(t => t.cents === rounded);
    return match ? match.name : '?';
  }

// Quarter-tone class names used by the graph color scale. Includes all 24
// possible pitch classes within an octave.
const PITCH_CLASSES = QUARTER_TONE_NAMES.map(t => t.name);

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
  // Walk all tracks, merging events in track order then by absolute time
    // into a single events[] stream (back-compat — playback + graph still
    // work off the merged stream). We ALSO record per-track events[] and
    // collect time-signature meta events so the synth can pick a single
    // track and emit <time> elements per measure.
    const perTrackEvents = tracks.map(() => []);
    const timeSignatures = [];   // [{ tick, num, den }]
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      let p = 0;
      let t = 0;                  // absolute tick within this track
      let runningStatus = 0;
      while (p < track.length) {
        let delta;
        [delta, p] = readVarLen(track, p);
        t += delta;
        let status = track[p];
        if (status < 0x80) {
          // Running status — the previous status byte still applies.
          status = runningStatus;
        } else {
          p++;
          if (status >= 0x80 && status < 0xf0) runningStatus = status;
        }
        if (status === 0xff) {
          // Meta event.
          const metaType = track[p++];
          let len;
          [len, p] = readVarLen(track, p);
          if (metaType === 0x51 && len === 3) {
            microsPerQuarter = (track[p] << 16) | (track[p + 1] << 8) | track[p + 2];
            tempoBPM = Math.round(60_000_000 / microsPerQuarter);
          } else if (metaType === 0x58 && len === 4) {
            // Time signature: numerator, denominator (log2), CC, bb.
            // FF 58 04 nn dd cc bb — dd is the power of 2 for the
            // denominator, so dd=2 → /4, dd=3 → /8, etc.
            const num = track[p];
            const denPow = track[p + 1];
            const den = Math.pow(2, denPow);
            timeSignatures.push({ tick: t, num, den });
          }
          p += len;
        } else if (status === 0xf0 || status === 0xf7) {
          let len;
          [len, p] = readVarLen(track, p);
          p += len;
        } else {
          const hi = status & 0xf0;
          const channel = status & 0x0f;   // 0-15, 9 = GM percussion
          if (hi === 0x90) {
            const midiNote = track[p++];
            const vel = track[p++];
            const cents = midiNote * 100;
            if (vel > 0) {
              const ev = { timeTicks: t, type: 'on', note: cents, vel, tempoBPM, track: ti, channel };
              events.push(ev);
              perTrackEvents[ti].push(ev);
            } else {
              const ev = { timeTicks: t, type: 'off', note: cents, tempoBPM, track: ti, channel };
              events.push(ev);
              perTrackEvents[ti].push(ev);
            }
          } else if (hi === 0x80) {
            const midiNote = track[p++];
            const vel = track[p++];
            const cents = midiNote * 100;
            const ev = { timeTicks: t, type: 'off', note: cents, vel, tempoBPM, track: ti, channel };
            events.push(ev);
            perTrackEvents[ti].push(ev);
          } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
            p += 2;
          } else if (hi === 0xc0 || hi === 0xd0) {
            p += 1;
          } else {
            throw new Error(`Unknown MIDI status byte 0x${status.toString(16)} at track offset ${p - 1}`);
          }
        }
      }
    }

    // Sort by absolute tick time so multi-track playback is correctly interleaved.
    events.sort((a, b) => a.timeTicks - b.timeTicks);
    // Sort time signatures by tick so the synth can find the active one
    // for any given measure with a binary search.
    timeSignatures.sort((a, b) => a.tick - b.tick);
    return { events, ticksPerQuarter, tracks: perTrackEvents, timeSignatures };
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
  // Absolute frequency per pitch NAME (how often each pitch appears in
  // the whole piece — used for the "% of piece" annotation on each node).
  // We count by name rather than by raw cents because two cent values
  // (e.g. 8150 and 8200) might both round to the same display name
  // ("A↑5" and "A5" are different names, but if they did collide, we'd
  // want them summed). The transition-graph logic below also uses names.
  const freq = new Map();
  for (const n of notes) {
    const name = centsToPitch(n);
    freq.set(name, (freq.get(name) || 0) + 1);
  }
  const totalNotes = notes.length || 1;   // avoid divide-by-zero

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
    const curName = centsToPitch(cur);
    nodeSet.add(curName);
    for (const [nxt, count] of inner) {
      const nxtName = centsToPitch(nxt);
      nodeSet.add(nxtName);
      // `count` is the raw number of times this transition occurred
      // (used for the hover tooltip in graph.js). `value` is the
      // conditional probability: P(nxt | cur) = count / total-out-from-cur.
      // Both are kept on the link object so the graph can render the
      // label (value * 100%) and the tooltip (count) from the same data.
      links.push({
        source: curName,
        target: nxtName,
        value: count / total,
        count,
      });
    }
  }
  // Include every pitch in freq (covers the last note of the piece
  // which has no outgoing transition).
  for (const name of freq.keys()) nodeSet.add(name);
  const nodes = Array.from(nodeSet).sort().map(id => {
    const count = freq.get(id) || 0;
    return {
      id,
      count,                                  // absolute occurrences
      frequency: count / totalNotes,          // % of whole piece (0..1)
    };
  });
  return { nodes, links };
}

// ---------------------------------------------------------------------------
// computeStats: note counts, self-loops, top transitions, pitch range.
// `graph` is the output of buildTransitionGraph above.
// ---------------------------------------------------------------------------
function computeStats(notes, graph) {
  const uniqueNotes = Array.from(new Set(notes)).sort((a, b) => a - b);
  const uniqueNames = uniqueNotes.map(centsToPitch);

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
    // hi - lo is now in cents. 100 cents = 1 semitone.
    const semitones = (hi - lo) / 100;
    let semStr;
    if (semitones % 1 === 0) {
      semStr = String(semitones);
    } else if (Number.isInteger(semitones * 2)) {
      // Half-semitone — show as 0.5, not 0.50
      semStr = (semitones).toFixed(1);
    } else {
      semStr = semitones.toFixed(2);
    }
    rangeStr = `${centsToPitch(lo)} – ${centsToPitch(hi)} (${semStr} semitones)`;
  }

  return {
    note_count: notes.length,
    unique_note_count: uniqueNotes.length,
    unique_notes: uniqueNames,
    transition_count: transitionCount,
    all_transitions: ranked.map(([from, to, prob]) => ({
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
  const parsed = parseMidi(bytes);
  const { events, ticksPerQuarter, tracks, timeSignatures } = parsed;
  const notes = notesFromEvents(events);
  const graph = buildTransitionGraph(notes);
  const stats = computeStats(notes, graph);
  // Phase 1: per-track analyses. Each non-empty track gets its own
  // graph + stats so the user can pick which track to visualize as
  // the melody (important for multi-track MIDI like string quartets
  // where the merged "melody" would just be whatever-note-came-next).
  // The "merged" analysis is also kept as the first entry — it's
  // what the user sees if they don't change the dropdown.
  const trackAnalyses = buildTrackAnalyses(tracks);
  // Phase 1 heuristic: pick the best melodic candidate. We expose
  // this as a hint for the UI's "Auto (pick lead)" option; the
  // UI's default is the first track, not the auto-pick, so this
  // is informational only.
  const autoMelodic = pickMelodicTrack(trackAnalyses);
  // Phase 2: harmonic analysis (chord sequence + chord graph).
  // Uses the merged events across all tracks so simultaneous
  // pitches form one chord. Quarter-note windows by default.
  const chordWindows = chordSequence(events, { ticksPerQuarter });
  const chordGraph = buildChordTransitionGraph(chordWindows);
  const monophonic = isMonophonicSequence(chordWindows);
  return {
    graph, stats, events, ticksPerQuarter, tracks, timeSignatures,
    trackAnalyses, autoMelodic,
    chordWindows, chordGraph, monophonic,
  };
}

// Phase 1: build a self-contained analysis (graph + stats) for each
// non-empty track. A "track" here is whatever parseMidi emitted — for
// multi-track files it's one MIDI track per instrument; for single-
// track files (piano, voice, monophonic solo) it's the whole file.
//
// We do NOT try to separate voices within a single track here. Voice
// separation is a Phase 3 enhancement; for now, single-track files
// produce one entry and polyphonic piano is best handled via the
// harmonic graph.
function buildTrackAnalyses(perTrackEvents) {
  const out = [];
  for (let ti = 0; ti < perTrackEvents.length; ti++) {
    const trackEvents = perTrackEvents[ti];
    const onCount = trackEvents.filter(e => e.type === 'on').length;
    if (onCount === 0) continue;          // skip silent/meta-only tracks
    const notes = notesFromEvents(trackEvents);
    const graph = buildTransitionGraph(notes);
    const stats = computeStats(notes, graph);
    // Pitch range for the dropdown label.
    let lo = Infinity, hi = -Infinity;
    for (const n of notes) {
      if (n < lo) lo = n;
      if (n > hi) hi = n;
    }
    // Average velocity — percussion tracks (channel 9) tend to have
    // very uniform short notes; we expose this so the picker UI can
    // mark percussion explicitly.
    let velSum = 0, velN = 0;
    for (const e of trackEvents) {
      if (e.type === 'on' && typeof e.vel === 'number') {
        velSum += e.vel;
        velN++;
      }
    }
    const avgVel = velN ? velSum / velN : 0;
    // Channel of the first note-on — used to detect channel 9
    // (General MIDI percussion).
    let channel = null;
    for (const e of trackEvents) {
      if (e.type === 'on') { channel = e.channel; break; }
    }
    out.push({
      trackIndex: ti,
      userLabel: `Track ${ti + 1}`,
      noteCount: onCount,
      pitchRange: [lo, hi],
      avgVelocity: avgVel,
      channel,
      isPercussion: channel === 9,
      graph,
      stats,
    });
  }
  return out;
}

// Phase 1: pick the "best melodic" track from a set of track analyses.
// Heuristic: discard percussion tracks and tracks that are mostly
// silence / very-short stabs, then score the remaining tracks by
// `noteCount × pitchVariance × (1 - restRatio)`. Highest score wins.
//
// This is intentionally conservative — it should never pick a
// percussion or click track. When in doubt it returns the first
// non-percussion track.
function pickMelodicTrack(trackAnalyses) {
  if (!trackAnalyses.length) return null;
  // Filter out percussion and very-low-note-count tracks.
  const candidates = trackAnalyses.filter(t =>
    !t.isPercussion && t.noteCount >= 8
  );
  if (!candidates.length) {
    // Fall back to first track if all were filtered out.
    return trackAnalyses[0].trackIndex;
  }
  // Score = noteCount × pitchStdDev × voiceActivityRatio.
  // voiceActivityRatio = unique-pitches / noteCount (more melodic
  // lines have higher pitch diversity than rhythmic ostinatos).
  let best = null;
  let bestScore = -Infinity;
  for (const t of candidates) {
    const range = t.pitchRange[1] - t.pitchRange[0];     // in cents
    const pitchStdDev = range / 100;                     // semitones of range
    const uniquePitches = t.graph.nodes.length;
    const voiceActivity = t.noteCount ? uniquePitches / t.noteCount : 0;
    const score = t.noteCount * Math.max(1, pitchStdDev) * voiceActivity;
    if (score > bestScore) {
      bestScore = score;
      best = t.trackIndex;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Phase 2: harmonic analysis — chord identification + chord transition graph
//
// For each window of MIDI events (default: one quarter note), collect all
// currently-sounding pitches, identify the chord, and emit a chord label.
// Then build a Markov-style transition graph over the chord labels.
//
// The classifier has two modes:
//   1. 12-TET — if every pitch in the window is on a 12-TET pitch class
//      (cents mod 100 == 0), match against a vocabulary of standard chord
//      templates (maj, min, dim, aug, sus, 7th variants, etc.).
//   2. Quarter-tone — if any pitch is off the 12-TET grid (cents mod 100
//      == 50), label by LITERAL SPELLING so the user can read what they
//      hear ("C with neutral third", "neutral triad", etc.) rather than
//      being forced into a wrong 12-TET name.
//
// Inversions are handled: if the lowest-sounding pitch is not the chord
// root, the label gets a "/<bass>" suffix (e.g. "C/E" for a 1st-inversion
// C major with E in the bass).
// ---------------------------------------------------------------------------

// Chord vocabulary: each template is a sorted list of intervals (in cents
// above the root). The matching algorithm tries every pitch in the chord
// as a candidate root and picks the template whose interval set has the
// smallest edit distance to the observed intervals.
//
// 24 templates — covers the vast majority of Western tonal music. We
// deliberately do NOT include slash chords, polychords, or extended
// jazz harmony (9ths, 11ths, 13ths, altered dominants). When the user
// needs those they can fall back to the literal-spelling labeler.
const CHORD_TEMPLATES = [
  // Triads
  { name: '',     intervals: [0, 400, 700]            },  // major triad
  { name: 'm',    intervals: [0, 300, 700]            },  // minor triad
  { name: 'dim',  intervals: [0, 300, 600]            },  // diminished
  { name: 'aug',  intervals: [0, 400, 800]            },  // augmented
  { name: 'sus2', intervals: [0, 200, 700]            },  // suspended 2nd
  { name: 'sus4', intervals: [0, 500, 700]            },  // suspended 4th
  { name: '5',    intervals: [0, 700]                 },  // power chord
  // 6ths (not technically 7th chords but commonly grouped with extensions)
  { name: '6',    intervals: [0, 400, 700, 900]       },  // major 6
  { name: 'm6',   intervals: [0, 300, 700, 900]       },  // minor 6
  // 7th chords
  { name: 'maj7', intervals: [0, 400, 700, 1100]      },
  { name: 'm7',   intervals: [0, 300, 700, 1000]      },
  { name: '7',    intervals: [0, 400, 700, 1000]      },  // dominant 7
  { name: 'dim7', intervals: [0, 300, 600, 900]       },
  { name: 'm7b5', intervals: [0, 300, 600, 1000]      },  // half-diminished
  { name: '7sus4',intervals: [0, 500, 700, 1000]      },
  // Added tones
  { name: 'add9', intervals: [0, 400, 700, 1400]      },
  { name: 'madd9',intervals: [0, 300, 700, 1400]      },
  // 9th chords (treat as 7th + 9th)
  { name: '9',    intervals: [0, 400, 700, 1000, 1400]},
  { name: 'm9',   intervals: [0, 300, 700, 1000, 1400]},
  // 11th (5-note — only as exact match, no edit distance)
  { name: '7add11', intervals: [0, 400, 700, 1000, 1700]},
  // Suspended 7ths
  { name: '7sus2',intervals: [0, 200, 700, 1000]      },
  // 13 (abbreviated — root 3 5 7 13)
  { name: '13',   intervals: [0, 400, 700, 1000, 2100]},
  // Altered dominants (single alteration only — full altered dominants
  // would need a separate chord-symbol vocabulary)
  { name: '7b9',  intervals: [0, 400, 700, 1000, 1300]},
  { name: '7#9',  intervals: [0, 400, 700, 1000, 1500]},
];

// Reduce a pitch to its "chord signature" — the cents value mod 1200
// (so all octaves collapse to one pitch class). For quarter-tone support
// we keep the 50-cent resolution; for 12-TET we round to multiples of 100.
function _chordSig(cents) {
  const m = ((cents % 1200) + 1200) % 1200;   // safe mod
  return Math.round(m);                       // round half-cents to whole
}

// Reduce to the nearest 12-TET pitch class (cents mod 100 → 0 if within 25¢,
// else rounded to nearest 100). For matching against 12-TET templates.
function _chordSig12(cents) {
  const m = ((cents % 1200) + 1200) % 1200;
  return Math.round(m / 100) * 100;
}

// Check if a pitch is on the 12-TET grid (mod 100 == 0, within rounding).
function _isOn12TET(cents) {
  const m = ((cents % 100) + 100) % 100;
  return m < 5 || m > 95;       // tolerate 5-cent tolerance
}

// Identify the chord in a set of pitches (array of cents values).
// Returns { label, root, bass, quality, intervals, hasQuarterTone }.
// label is the user-facing string ("C", "Cm", "C/E", "C (neutral third)",
// "C + E half-flat + G", etc.).
function _identifyChord(pitches) {
  if (pitches.length === 0) {
    return { label: '(silence)', root: null, bass: null, intervals: [], hasQuarterTone: false };
  }
  if (pitches.length === 1) {
    const only = pitches[0];
    const name = centsToPitch(only);
    return { label: name, root: only, bass: only, intervals: [0], hasQuarterTone: !_isOn12TET(only) };
  }
  // Sort ascending and dedupe (same pitch class multiple times = one chord tone).
  const sigs12 = Array.from(new Set(pitches.map(_chordSig12))).sort((a, b) => a - b);
  const hasQuarterTone = pitches.some(p => !_isOn12TET(p));
  // The bass is the lowest-sounding pitch (regardless of octave).
  const bass = pitches.reduce((a, b) => (a <= b ? a : b));
  // If any pitch is quarter-tone, we use the literal-spelling path
  // (12-TET templates can't faithfully represent a neutral third).
  if (hasQuarterTone) {
    return _labelBySpelling(pitches, bass);
  }
  return _labelBy12TET(sigs12, bass);
}

// 12-TET template matching. Pick the (root, template) pair that minimizes
// the number of observed intervals not explained by the template.
// Returns the best label or a literal-spelling fallback if no template
// matches within a small tolerance.
function _labelBy12TET(sigs12, bass) {
  // Try every observed pitch as a candidate root.
  let best = null;
  for (let i = 0; i < sigs12.length; i++) {
    const candidateRoot = sigs12[i];
    const intervals = sigs12.map(s => ((s - candidateRoot) + 1200) % 1200);
    intervals.sort((a, b) => a - b);
    for (const t of CHORD_TEMPLATES) {
      const score = _matchScore(intervals, t.intervals);
      // Penalty for inverted chords (bass not the root) — keep them
      // findable but rank them below the root-position match.
      const inverted = ((bass % 1200) + 1200) % 1200 !== candidateRoot;
      const adjusted = score + (inverted ? 0.5 : 0);
      if (!best || adjusted < best.score) {
        best = { score: adjusted, root: candidateRoot, intervals, template: t, inverted };
      }
    }
  }
  if (!best || best.score > 0.5) {
    // No good template match — emit literal-spelling fallback.
    return _labelBySpelling(sigs12.map(s => s + 1200 * Math.floor(bass / 1200)), bass);
  }
  const rootSao = centsToStepAlterOctave(best.root + 1200 * Math.floor(bass / 1200));
  let label = _formatRoot(rootSao) + best.template.name;
  if (best.inverted) {
    const bassSao = centsToStepAlterOctave(bass);
    label += '/' + _formatRoot(bassSao);
  }
  return {
    label,
    root: best.root + 1200 * Math.floor(bass / 1200),
    bass,
    intervals: best.intervals,
    templateName: best.template.name,
    hasQuarterTone: false,
  };
}

// Match observed intervals to a template. Score = number of observed
// intervals not in the template + number of template intervals not in the
// observed set. Lower is better.
function _matchScore(observed, tmpl) {
  const oSet = new Set(observed);
  const tSet = new Set(tmpl);
  let score = 0;
  for (const x of observed) if (!tSet.has(x)) score++;
  for (const x of tmpl) if (!oSet.has(x)) score++;
  // Slight bonus when observed and template have the same size
  // (otherwise an observed single note matches every 1-note template
  // like the power chord).
  if (observed.length === tmpl.length) score -= 0.1;
  return score;
}

// Literal-spelling label for quarter-tone chords. Sorts pitches by cents,
// groups by letter+alteration, and emits a descriptive label.
// Examples:
//   {C4, E half-flat 4, G4}      → "C (neutral third)"
//   {C4, E half-flat 4, G half-flat 4} → "C (neutral 3rd, half-flat 5th)"
//   {C half-flat 4, E half-flat 4, G4} → "C (neutral 1st, neutral 3rd)"
//   unrecognized                  → "C + E half-flat + G half-flat + B half-flat"
function _labelBySpelling(pitches, bass) {
  // Compute the spelling for each pitch using centsToStepAlterOctave.
  const spellings = pitches.map(c => {
    const sao = centsToStepAlterOctave(c);
    return { cents: c, sao, letter: sao ? sao.step : '?' };
  });
  // Sort spellings ascending by cents (preserves bass-first order in label).
  spellings.sort((a, b) => a.cents - b.cents);
  // Pick the lowest-sounding pitch as the root (since we don't have a
  // vocabulary to test against).
  const root = spellings[0];
  const rootName = root.sao ? _formatRoot(root.sao) : '?';
  // Special-case 1: NEUTRAL TRIAD (the only named microtonal chord
  // template for v1 — see user's design decision). Shape:
  //   root + neutral 3rd + perfect 5th
  // where neutral 3rd = (root + 350¢) and the pitch is spelled
  // <3rd letter> half-flat (e.g. C + E half-flat + G).
  // Intervals: 0/350/700 (in cents within an octave).
  if (pitches.length === 3) {
    // Try every pitch as a candidate root (so inversions are
    // recognised). The neutral triad shape is 0/350/700 in cents
    // from the root. We pick the candidate root whose interval set
    // matches that shape best; ties broken by preferring the
    // root-position match (lowest sounding pitch is the root).
    const intervals = [0, 350, 700];
    let bestRoot = null;
    for (const candidateRootCents of pitches) {
      const ivs = pitches
        .map(p => ((p - candidateRootCents) % 1200 + 1200) % 1200)
        .sort((a, b) => a - b);
      if (ivs[0] === 0 && ivs[1] === 350 && ivs[2] === 700) {
        // Prefer the candidate where bass === root (root position).
        const isRootPos = bass === candidateRootCents;
        if (!bestRoot || isRootPos) {
          bestRoot = candidateRootCents;
          if (isRootPos) break;  // best possible match
        }
      }
    }
    if (bestRoot !== null) {
      const rootSao = centsToStepAlterOctave(bestRoot);
      const rootName = rootSao ? _formatRoot(rootSao) : '?';
      // Inversions: if the bass isn't the root, append "/<bass>".
      let label = `${rootName} neutral triad`;
      if (bass !== bestRoot) {
        const bassSao = centsToStepAlterOctave(bass);
        if (bassSao) label += '/' + _formatRoot(bassSao);
      }
      return {
        label,
        root: bestRoot,
        bass,
        intervals,
        hasQuarterTone: true,
      };
    }
  }
  // Compute each non-root pitch's alteration relative to the root's letter.
  // This is approximate — quarter-tone music doesn't have a canonical
  // "root" the way 12-TET does. We use the bass as the conventional root.
  const alterations = [];
  const unknownPitches = [];
  for (const s of spellings) {
    if (s === root) continue;
    if (!s.sao) { unknownPitches.push(s); continue; }
    // Describe the alteration relative to the root's letter class.
    const rel = _relativeAlteration(root.sao, s.sao);
    alterations.push(rel);
  }
  let label;
  // Use the descriptive form if at least one pitch in the chord is a
  // quarter-tone alteration (raised/neutral/lowered). Pitches that
  // are pure 12-TET intervals from the root (perfect 5th, octave, etc.)
  // can appear in the description as plain "5th"/"8va" without breaking
  // the descriptive form.
  const hasQuarterToneAlteration = alterations.some(a => a.quarterTone);
  if (alterations.length > 0 && unknownPitches.length === 0 &&
      hasQuarterToneAlteration) {
    // All non-root pitches have known alterations, and at least one
    // of them is a quarter-tone deviation. Use the descriptive form.
    const descs = alterations.map(a => a.desc);
    label = `${rootName} (${descs.join(', ')})`;
  } else if (alterations.length === 0 && unknownPitches.length === 0) {
    // Single pitch — already handled in _identifyChord.
    label = rootName;
  } else {
    // Mixed / unknown — literal spelling.
    label = spellings.map(s => _formatPitch(s.sao)).join(' + ');
  }
  return {
    label,
    root: root.cents,
    bass,
    intervals: [],
    hasQuarterTone: spellings.some(s => s.sao && s.sao.alter !== 0 && s.sao.alter !== 1 && s.sao.alter !== -1),
  };
}

// Format a root name as just the letter + alteration (no octave).
// Used for chord labels: "C", "F#", "Bb", "C half-flat".
// Quarter-tones in the root get the long "half-flat" / "half-sharp"
// form so the user can see the chord's exact spelling in the label.
function _formatRoot(sao) {
  let name = sao.step;
  if (sao.alter === 1) name += '#';
  else if (sao.alter === -1) name += 'b';
  else if (sao.alter === 0.5) name += '\u2191';   // short form for compactness
  else if (sao.alter === -0.5) name += ' half-flat';
  return name;
}

// Format a pitch for literal-spelling labels: "E half-flat", "G#", etc.
// Handles all alter values from -1 to 1.5 that we expect from
// centsToStepAlterOctave (sharp-spelled enharmonic convention).
function _formatPitch(sao) {
  if (!sao) return '?';
  let name = sao.step;
  if (sao.alter === 1) name += '#';
  else if (sao.alter === -1) name += 'b';
  else if (sao.alter === 0.5) name += ' half-sharp';
  else if (sao.alter === -0.5) name += ' half-flat';
  else if (sao.alter === 1.5) name += '# half-sharp';   // double sharp territory
  else if (sao.alter === -1.5) name += 'b half-flat';
  else if (sao.alter !== 0) name += ` (alter ${sao.alter})`;
  return name;
}

// Describe the alteration of a non-root pitch relative to the root's
// LETTER (not its chromatic position). This gives labels that match
// how musicians THINK about chords:
//   root C, pitch E half-flat  → "neutral 3rd" (letter interval is a 3rd,
//                                lowered by 50¢ from major)
//   root C, pitch D# half-sharp → "raised 2nd" (letter interval is a 2nd,
//                                raised by 50¢ from natural D)
//   root C, pitch G             → "5th" (letter interval is a 5th, no
//                                alteration)
//
// The KEY insight: we describe by letter-distance (2nd, 3rd, etc.) not
// chromatic distance, because that's how chord tones are named in
// practice. "D#↑" is conceptually a raised 2nd, not a "neutral 3rd" —
// the user wrote D# (a 2nd letter), and ↑ (raised by 50¢).
function _relativeAlteration(rootSao, pitchSao) {
  // Letter-to-position (number of letter steps from C).
  // C=0, D=1, E=2, F=3, G=4, A=5, B=6.
  const LETTER_POSITION = { C:0, D:1, E:2, F:3, G:4, A:5, B:6 };
  const LETTER_NAMES_FROM_ROOT = [
    'root', '2nd', '3rd', '4th', '5th', '6th', '7th',
  ];
  const rootPos = LETTER_POSITION[rootSao.step] || 0;
  const pitchPos = LETTER_POSITION[pitchSao.step] || 0;
  // Letter interval (wraps past 7 to a 7th-with-octave-bump).
  let letterSteps = pitchPos - rootPos;
  if (letterSteps < 0) letterSteps += 7;       // wrap within the diatonic scale
  // Adjust for octave offset: if pitch is in a higher octave than root,
  // the letter interval is the same letter but +7 (octave).
  const octaveOffset = pitchSao.octave - rootSao.octave;
  // Now decide the name: use simple letter interval (2nd/3rd/...) if
  // pitch and root are in the same or adjacent octave, else add "high"
  // prefix or use a compound name.
  const baseName = LETTER_NAMES_FROM_ROOT[letterSteps] || `${letterSteps}th`;
  // For the ideal alteration, we use the root's own alteration as the
  // baseline (most pitches in a chord will share the root's quality
  // when spelled relatively). E.g. Cm chord: rootC alter 0, ideal for
  // Eb is alter -1 (minor 3rd), but for our labeling purposes we
  // assume the "natural" position is whatever alter makes it a perfect
  // interval in the major scale. That's almost always alter=0.
  const idealAlter = 0;
  const actualAlter = pitchSao.alter;
  const deviation = actualAlter - idealAlter;
  let desc;
  if (Math.abs(deviation) < 0.01) {
    desc = baseName;
  } else if (Math.abs(deviation - 0.5) < 0.01) {
    desc = `raised ${baseName}`;
  } else if (Math.abs(deviation + 0.5) < 0.01) {
    desc = `neutral ${baseName}`;
  } else if (deviation > 0) {
    desc = `raised ${baseName}`;
  } else {
    desc = `lowered ${baseName}`;
  }
  // Any non-integer deviation counts as a quarter-tone modification.
  // (Integer deviations are full-tone alterations, e.g. raise a 4th
  // to a #4 = +1 whole tone — not quarter-tone territory.)
  const quarterTone = Math.abs(deviation - Math.round(deviation)) > 0.01;
  return { quarterTone, desc };
}

// Group events into fixed-size windows and identify the chord in each.
// Returns:
//   [{ startTick, endTick, pitches: [cents, ...], label, root, bass }, ...]
//
// Options:
//   ticksPerQuarter  — required for the default quarter-note window.
//   windowTicks      — override the window size (default = ticksPerQuarter).
//   maxWindows       — safety cap (default 2000 — ~2.5 minutes of 4/4 music).
//
// Algorithm:
//   1. Walk events once, maintaining a "currently sounding" pitch set.
//   2. At each window boundary (0, windowTicks, 2*windowTicks, ...), close
//      the current window: emit its {startTick, pitches, label}, then
//      start a fresh window.
//   3. If a window is empty (silence), emit '(silence)' so the chord
//      sequence stays aligned with the beat grid.
function chordSequence(events, options = {}) {
  const ticksPerQuarter = options.ticksPerQuarter || 480;
  const windowTicks = options.windowTicks || ticksPerQuarter;
  const maxWindows = options.maxWindows || 2000;
  const lastTick = events.length ? events[events.length - 1].timeTicks : 0;
  // Number of complete windows to emit. A window is [w*windowTicks, (w+1)*windowTicks).
  // If lastTick is exactly on a window boundary, we don't emit a trailing
  // empty window — that's how musical phrase boundaries work.
  const totalWindows = Math.min(
    lastTick === 0 ? 0 : Math.ceil(lastTick / windowTicks),
    maxWindows
  );
  // Maintain a Map<cents, count> of currently-sounding pitches so we
  // can handle re-attacks (a note struck twice without an intervening
  // note_off shouldn't appear twice in the chord).
  const sounding = new Map();
  let eventIdx = 0;
  const windows = [];
  for (let w = 0; w < totalWindows; w++) {
    const startTick = w * windowTicks;
    const endTick = (w + 1) * windowTicks;
    // Process every event whose time falls in [startTick, endTick).
    while (eventIdx < events.length && events[eventIdx].timeTicks < endTick) {
      const ev = events[eventIdx];
      if (ev.type === 'on' && ev.vel > 0) {
        sounding.set(ev.note, (sounding.get(ev.note) || 0) + 1);
      } else if (ev.type === 'off' || (ev.type === 'on' && ev.vel === 0)) {
        const c = sounding.get(ev.note) || 0;
        if (c <= 1) sounding.delete(ev.note);
        else sounding.set(ev.note, c - 1);
      }
      eventIdx++;
    }
    const pitches = Array.from(sounding.keys()).sort((a, b) => a - b);
    const chord = _identifyChord(pitches);
    windows.push({
      startTick,
      endTick,
      pitches,
      label: chord.label,
      root: chord.root,
      bass: chord.bass,
      hasQuarterTone: chord.hasQuarterTone,
    });
  }
  return windows;
}

// Detect whether a chord sequence is "effectively monophonic" — every
// window has 0 or 1 sounding pitch. Returns true if so.
function isMonophonicSequence(windows) {
  if (!windows.length) return true;
  for (const w of windows) {
    if (w.pitches.length > 1) return false;
  }
  return true;
}

// Build a chord-transition graph from a chord sequence.
// Same shape as buildTransitionGraph but the nodes are chord labels
// (strings) instead of pitch names.
function buildChordTransitionGraph(windows) {
  // Count chord occurrences and ignore '(silence)' so the graph isn't
  // dominated by rests. We also collapse consecutive duplicate labels
  // so the graph reflects chord PROGRESSION, not frame-by-frame identity.
  const seq = [];
  let prev = null;
  for (const w of windows) {
    if (w.label === '(silence)') continue;
    if (w.label !== prev) {
      seq.push(w.label);
      prev = w.label;
    }
  }
  // Frequency of each chord (how often it appears in the sequence).
  const freq = new Map();
  for (const lbl of seq) freq.set(lbl, (freq.get(lbl) || 0) + 1);
  const totalChords = seq.length || 1;
  // Transitions: chord[i] → chord[i+1].
  const counts = new Map();   // cur → Map(nxt → count)
  const totals = new Map();
  for (let i = 0; i < seq.length - 1; i++) {
    const cur = seq[i];
    const nxt = seq[i + 1];
    if (!counts.has(cur)) counts.set(cur, new Map());
    counts.get(cur).set(nxt, (counts.get(cur).get(nxt) || 0) + 1);
    totals.set(cur, (totals.get(cur) || 0) + 1);
  }
  const links = [];
  const nodeSet = new Set();
  for (const [cur, inner] of counts) {
    const total = totals.get(cur);
    nodeSet.add(cur);
    for (const [nxt, count] of inner) {
      nodeSet.add(nxt);
      links.push({
        source: cur,
        target: nxt,
        value: count / total,
        count,
      });
    }
  }
  for (const lbl of freq.keys()) nodeSet.add(lbl);
  const nodes = Array.from(nodeSet).sort().map(id => {
    const count = freq.get(id) || 0;
    return { id, count, frequency: count / totalChords };
  });
  return { nodes, links };
}

// ---------------------------------------------------------------------------
// File-type detection: sniff content rather than relying on extension. Real
//
// The extension hint is used to make error messages more helpful ("looks like
// XML but you gave it a .mid extension — try renaming to .musicxml") but
// does NOT influence the returned type. Routing is always by content.
// ---------------------------------------------------------------------------
function detectFileType(bytes, filename) {
  if (!bytes || bytes.length < 4) {
    return { type: 'unknown', reason: 'file too small to sniff' };
  }
  // First 4 bytes as ASCII.
  const head = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (head === 'MThd') return { type: 'midi' };
  if (head === 'PK\x03\x04' || head === 'PK\x05\x06' || head === 'PK\x07\x08') {
    return { type: 'mxl' };
  }
  // XML files often start with "<?xm" (the processing instruction) or
  // directly with the root element. Check for "<?xm" first (most common),
  // then "<sco" for files that omit the prolog (some exporters do this).
  // We only look at the first 5 bytes to keep this cheap.
  if (bytes.length >= 5) {
    const head5 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]);
    if (head5.startsWith('<?xml') || head5.startsWith('<sco')) {
      return { type: 'musicxml' };
    }
  }
  // Last-ditch: search for "<score-" in the first 1KB. Some files have a
  // BOM or whitespace before the root element.
  const sniffLen = Math.min(bytes.length, 1024);
  let text = '';
  for (let i = 0; i < sniffLen; i++) {
    const c = bytes[i];
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) break;  // stop at binary
    text += String.fromCharCode(c);
  }
  if (text.indexOf('<score-') >= 0 || text.indexOf('<?xml') >= 0) {
    return { type: 'musicxml' };
  }
  // Build a helpful hint if we can guess what they MEANT to upload.
  let hint = '';
  if (filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
      hint = ' (your file has a .mid extension but the content does not look like MIDI — it might be a MusicXML file renamed to .mid; try renaming it to .musicxml)';
    } else if (lower.endsWith('.mxl')) {
      hint = ' (compressed MusicXML .mxl is recognized but not yet parsed — export as uncompressed .musicxml)';
    } else if (lower.endsWith('.xml')) {
      hint = ' (your file has .xml extension but is not a valid MusicXML document)';
    } else if (lower.endsWith('.musicxml')) {
      hint = ' (your file has .musicxml extension but the content does not start with valid XML)';
    }
  }
  return { type: 'unknown', reason: 'unrecognized file format' + hint };
}

// ---------------------------------------------------------------------------
// .mxl extraction: compressed MusicXML is a ZIP archive. The ZIP contains
// at minimum `META-INF/container.xml`, which points to the root MusicXML
// file (often named score.xml or music.xml). This function unzips, reads
// the container, then returns the rootfile content as a UTF-8 string.
//
// fflate is the unzip library — loaded via a <script> tag in index.html so
// it becomes `window.fflate`. In node tests we require it via npm (same
// module name) so the path is identical between test and browser code.
// Returns null on any failure (bad zip, missing container, no rootfile,
// fflate unavailable) and writes a one-line reason to a passed-in error
// object so app.js can show it to the user.
// ---------------------------------------------------------------------------
function extractMxl(bytes, errors) {
  // Resolve fflate: in node it's `require('fflate')`, in browser it's the
  // global set by the script tag in index.html. If neither is available,
  // the error message tells the user to reload the page.
  let fflateLib;
  if (typeof fflate !== 'undefined') {
    fflateLib = fflate;
  } else if (typeof require !== 'undefined') {
    try { fflateLib = require('fflate'); } catch (e) { /* fall through */ }
  }
  if (!fflateLib) {
    errors.reason = 'fflate library not loaded (reload the page)';
    return null;
  }
  // fflate.unzipSync returns { [filename]: Uint8Array }. Wrapped in
  // try/catch because malformed zips throw (not return null).
  let entries;
  try {
    entries = fflateLib.unzipSync(bytes);
  } catch (e) {
    errors.reason = 'not a valid ZIP archive: ' + e.message;
    return null;
  }
  // The container is conventionally META-INF/container.xml (always present
  // per the MusicXML spec). Some exporters put it elsewhere — fall back to
  // any file matching *container.xml if the canonical path is missing.
  let containerPath = 'META-INF/container.xml';
  if (!entries[containerPath]) {
    const match = Object.keys(entries).find(k => k.endsWith('container.xml'));
    if (!match) {
      errors.reason = 'no META-INF/container.xml in .mxl archive';
      return null;
    }
    containerPath = match;
  }
  // Parse the container XML to find the rootfile path. We use the DOMParser
  // in browser and @xmldom/xmldom in node — but to keep this dependency-
  // free, just regex for `full-path="..."` which is the only attribute that
  // matters. (Multiple rootfiles are allowed but uncommon; we take the
  // first.)
  const containerText = new TextDecoder('utf-8').decode(entries[containerPath]);
  const rootMatch = containerText.match(/full-path="([^"]+)"/);
  if (!rootMatch) {
    errors.reason = 'no <rootfile> element in container.xml';
    return null;
  }
  const rootPath = rootMatch[1];
  if (!entries[rootPath]) {
    errors.reason = 'rootfile "' + rootPath + '" not in archive';
    return null;
  }
  return new TextDecoder('utf-8').decode(entries[rootPath]);
}

// ---------------------------------------------------------------------------
// Exports — CommonJS for node tests, globals for browser <script> tag.
// ---------------------------------------------------------------------------
const api = {
  NOTE_NAMES: QUARTER_TONE_NAMES.map(t => t.name),  // 24 names per octave
  PITCH_CLASSES,
  QUARTER_TONE_NAMES,
  centsToPitch,
  pitchClass,
  stepAlterOctaveToCents,
  centsToStepAlterOctave,
  readVarLen,
  parseMidi,
  notesFromEvents,
  buildTransitionGraph,
  computeStats,
  ticksToSeconds,
  ticksToSecondsSegments,
  analyzeMidi,
  detectFileType,
  extractMxl,
  // Phase 2: harmonic analysis
  chordSequence,
  buildChordTransitionGraph,
  isMonophonicSequence,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.MidiGraph = api;
}