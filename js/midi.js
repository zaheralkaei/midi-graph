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
//       top_transitions, self_loop_count, self_loop_share, pitch_range.
//
//   centsToPitch(cents)                           → "C4" or "C# half-sharp 4"
//   stepAlterOctaveToCents(step, alter, octave)   → number (e.g. C half-sharp, 4 → 6050)
//   pitchClass(cents)                             → "C" / "C#" / "C half-sharp"
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
// half-tone as "[lower note] half-sharp" (sharp-going-up convention). The
// alternative "half-flat" spelling is equivalent but harder to scan visually.
// Names like "C half-sharp" are plain English per the project's house style.
const QUARTER_TONE_NAMES = [
  { cents:    0, name: 'C' },
  { cents:   50, name: 'C half-sharp' },
  { cents:  100, name: 'C#' },
  { cents:  150, name: 'C# half-sharp' },
  { cents:  200, name: 'D' },
  { cents:  250, name: 'D half-sharp' },
  { cents:  300, name: 'D#' },
  { cents:  350, name: 'D# half-sharp' },
  { cents:  400, name: 'E' },
  { cents:  450, name: 'E half-sharp' },
  { cents:  500, name: 'F' },
  { cents:  550, name: 'F half-sharp' },
  { cents:  600, name: 'F#' },
  { cents:  650, name: 'F# half-sharp' },
  { cents:  700, name: 'G' },
  { cents:  750, name: 'G half-sharp' },
  { cents:  800, name: 'G#' },
  { cents:  850, name: 'G# half-sharp' },
  { cents:  900, name: 'A' },
  { cents:  950, name: 'A half-sharp' },
  { cents: 1000, name: 'A#' },
  { cents: 1050, name: 'A# half-sharp' },
  { cents: 1100, name: 'B' },
  { cents: 1150, name: 'B half-sharp' },
];

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

  // cents → display name like "C4" or "C# half-sharp 4".
  function centsToPitch(cents) {
    if (cents == null || !isFinite(cents)) return '?';
    if (cents < 0) return '?';  // negative cents are unreachable through any
                                // current parser; return a marker instead of
                                // producing a misleading name like "?-2".
    const octave = Math.floor(cents / 1200) - 1;
    const withinOctave = cents - (octave + 1) * 1200;
    const rounded = roundToNearest50(withinOctave);
    const match = QUARTER_TONE_NAMES.find(t => t.cents === rounded);
    if (match) {
      // Insert a space between name and octave when the name itself contains
      // a space (e.g. "C half-sharp" + 4 → "C half-sharp 4"). Plain names
      // ("C", "C#") stay concatenated as before ("C4", "C#4").
      const sep = match.name.includes(' ') ? ' ' : '';
      return match.name + sep + octave;
    }
    return `?${cents}`;
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
          const midiNote = track[p++];
          const vel = track[p++];
          // MIDI is 12-TET — note byte → cents is exact (×100).
          const cents = midiNote * 100;
          if (vel > 0) {
            events.push({ timeTicks: t, type: 'on', note: cents, vel, tempoBPM });
          } else {
            // note_on with velocity 0 is the standard "note_off" shorthand.
            events.push({ timeTicks: t, type: 'off', note: cents, tempoBPM });
          }
        } else if (hi === 0x80) {
          const midiNote = track[p++];
          const vel = track[p++];
          const cents = midiNote * 100;
          events.push({ timeTicks: t, type: 'off', note: cents, vel, tempoBPM });
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
    const curName = centsToPitch(cur);
    nodeSet.add(curName);
    for (const [nxt, count] of inner) {
      const nxtName = centsToPitch(nxt);
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
// File-type detection: sniff content rather than relying on extension. Real
// users hit cases like "renamed a .musicxml to .mid by accident", or files
// saved with no extension at all. Sniffing the first few bytes is the only
// reliable signal. Returns one of:
//   'midi'      — starts with ASCII "MThd" (MIDI header)
//   'musicxml'  — starts with "<?xml" or "<score-" (XML prolog or root)
//   'mxl'       — starts with "PK" (ZIP local-file-header magic)
//                 (Compressed MusicXML — not parsed yet, but recognized so
//                 we can give a helpful error instead of a generic one.)
//   'unknown'   — doesn't match any of the above; show a generic error.
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
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.MidiGraph = api;
}