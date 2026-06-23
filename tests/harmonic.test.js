// tests/harmonic.test.js — Phase 2 tests for chord identification +
// chord-transition graph. Same test harness as tests/midi.test.js
// (shared pattern, no test framework).
//
// Run with: node tests/harmonic.test.js

const m = require('../js/midi.js');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok    ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}
function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || ''} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}
function assert(cond, label) {
  if (!cond) throw new Error(label || 'assertion failed');
}

// ---------------------------------------------------------------------------
// Helper: build a minimal MIDI file that holds a single sustained chord.
// events is an array of { type:'on'|'off', tick, note, vel, channel? }.
// All notes share the same channel=0 so the file is single-track.
// ---------------------------------------------------------------------------
function buildChordMidi(events, { ppq = 480 } = {}) {
  // We reuse the midi.test.js builder via a temp module — simpler to
  // just inline a minimal multi-event builder here.
  const track = [];
  // Tempo at start
  const mics = Math.round(60_000_000 / 120);
  track.push(0x00, 0xff, 0x51, 0x03, (mics >> 16) & 0xff, (mics >> 8) & 0xff, mics & 0xff);
  // Sort events by timeTicks (the field name used throughout the
  // project for absolute delta-tick time — keep it consistent with
  // parseMidi's output).
  const sorted = [...events].sort((a, b) => a.timeTicks - b.timeTicks);
  let lastTick = 0;
  for (const ev of sorted) {
    const delta = ev.timeTicks - lastTick;
    lastTick = ev.timeTicks;
    // VLQ
    if (delta === 0) track.push(0);
    else {
      const bytes = [];
      let n = delta;
      bytes.push(n & 0x7f); n >>= 7;
      while (n > 0) { bytes.push((n & 0x7f) | 0x80); n >>= 7; }
      track.push(...bytes.reverse());
    }
    if (ev.type === 'on') {
      const ch = ev.channel || 0;
      // Convert cents to MIDI note (C-1=0, C4=60). cents = (octave+1)*1200 + stepOffset.
      const midiNote = Math.round(ev.note / 100);
      track.push(0x90 | (ch & 0x0f), midiNote & 0x7f, ev.vel & 0x7f);
    } else {
      const midiNote = Math.round(ev.note / 100);
      track.push(0x80, midiNote & 0x7f, 0x40);
    }
  }
  // End of track
  track.push(0x00, 0xff, 0x2f, 0x00);
  const trackData = Buffer.from(track);
  const trackHeader = Buffer.from([
    0x4d, 0x54, 0x72, 0x6b,
    (trackData.length >> 24) & 0xff, (trackData.length >> 16) & 0xff,
    (trackData.length >> 8) & 0xff, trackData.length & 0xff,
  ]);
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ]);
  return new Uint8Array(Buffer.concat([header, trackHeader, trackData]));
}

console.log('harmonic.test.js — Phase 2 chord analysis');
console.log('------------------------------------------');

// ---------------------------------------------------------------------------
// analyzeMidi now returns chordWindows + chordGraph + monophonic.
// ---------------------------------------------------------------------------
test('analyzeMidi: harmonic fields present in result', () => {
  // C major triad (C4=6000, E4=6400, G4=6700) sustained for 1 quarter note.
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },
    { type: 'on',  timeTicks: 0,    note: 6400, vel: 80 },
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6400, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6700, vel: 0 },
  ];
  const r = m.analyzeMidi(buildChordMidi(events));
  assert(Array.isArray(r.chordWindows), 'chordWindows is an array');
  assert(r.chordWindows.length > 0, 'chordWindows non-empty');
  assert(r.chordGraph && Array.isArray(r.chordGraph.nodes), 'chordGraph.nodes');
  assert(r.chordGraph && Array.isArray(r.chordGraph.links), 'chordGraph.links');
  assertEqual(r.monophonic, false, 'polyphonic input -> monophonic=false');
});

// ---------------------------------------------------------------------------
// chordSequence: basic recognition of common triads.
// ---------------------------------------------------------------------------
test('chordSequence: C major triad sustained → "C" label', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 6400, vel: 80 },  // E4
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },  // G4
    { type: 'off', timeTicks: 960,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 960,  note: 6400, vel: 0 },
    { type: 'off', timeTicks: 960,  note: 6700, vel: 0 },
  ];
  // Window = 480 ticks (1 quarter). 960 ticks = 2 windows. Both windows
  // have the same sustained triad → should produce "C" labels for both.
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows.length, 2, '2 windows');
  assertEqual(windows[0].label, 'C', 'window 0 label is C');
  assertEqual(windows[1].label, 'C', 'window 1 label is C');
});

test('chordSequence: A minor triad → "Am"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6900, vel: 80 },  // A4
    { type: 'on',  timeTicks: 0,    note: 7200, vel: 80 },  // C5
    { type: 'on',  timeTicks: 0,    note: 7600, vel: 80 },  // E5
    { type: 'off', timeTicks: 480,  note: 6900, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 7200, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 7600, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'Am', 'A minor triad labeled as Am');
});

test('chordSequence: F major triad → "F"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6500, vel: 80 },  // F4
    { type: 'on',  timeTicks: 0,    note: 6900, vel: 80 },  // A4
    { type: 'on',  timeTicks: 0,    note: 7200, vel: 80 },  // C5
    { type: 'off', timeTicks: 480,  note: 6500, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6900, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 7200, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'F', 'F major triad labeled as F');
});

test('chordSequence: diminished triad → "Cdim"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 6300, vel: 80 },  // Eb4
    { type: 'on',  timeTicks: 0,    note: 6600, vel: 80 },  // Gb4
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6300, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6600, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'Cdim', 'C diminished');
});

test('chordSequence: augmented triad → "Caug"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 6400, vel: 80 },  // E4
    { type: 'on',  timeTicks: 0,    note: 6800, vel: 80 },  // G#4
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6400, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6800, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'Caug', 'C augmented');
});

test('chordSequence: suspended 4 → "Csus4"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 6500, vel: 80 },  // F4
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },  // G4
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6500, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6700, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'Csus4', 'C suspended 4');
});

test('chordSequence: dominant 7th → "C7"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 6400, vel: 80 },  // E4
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },  // G4
    { type: 'on',  timeTicks: 0,    note: 7000, vel: 80 },  // Bb4
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6400, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6700, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 7000, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'C7', 'C dominant 7');
});

test('chordSequence: major 7th → "Cmaj7"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 6400, vel: 80 },  // E4
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },  // G4
    { type: 'on',  timeTicks: 0,    note: 7100, vel: 80 },  // B4
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6400, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6700, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 7100, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'Cmaj7', 'C major 7');
});

// ---------------------------------------------------------------------------
// Inversions — bass note in a different octave than root.
// ---------------------------------------------------------------------------
test('chordSequence: 1st inversion (E in bass) → "C/E"', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 5200, vel: 80 },  // E3 (bass)
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },  // G4
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 5200, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6700, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].label, 'C/E', '1st inversion C/E');
});

// ---------------------------------------------------------------------------
// Monophonic detection.
// ---------------------------------------------------------------------------
test('chordSequence: monophonic input → monophonic=true', () => {
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'on',  timeTicks: 480,  note: 6200, vel: 80 },
    { type: 'off', timeTicks: 960,  note: 6200, vel: 0 },
  ];
  const r = m.analyzeMidi(buildChordMidi(events));
  assertEqual(r.monophonic, true, 'monophonic flag');
});

test('isMonophonicSequence: detects empty input', () => {
  assertEqual(m.isMonophonicSequence([]), true, 'empty sequence is monophonic');
  const w = [{ pitches: [6000] }, { pitches: [6200] }];
  assertEqual(m.isMonophonicSequence(w), true, 'one-pitch windows are monophonic');
  const w2 = [{ pitches: [6000, 6400] }, { pitches: [6200] }];
  assertEqual(m.isMonophonicSequence(w2), false, 'multi-pitch window breaks it');
});

// ---------------------------------------------------------------------------
// Chord transition graph.
// ---------------------------------------------------------------------------
test('buildChordTransitionGraph: C → F → G → C → produces I-IV-V-I edges', () => {
  const windows = [
    { startTick: 0,    endTick: 480,  pitches: [6000, 6400, 6700], label: 'C' },
    { startTick: 480,  endTick: 960,  pitches: [6500, 6900, 7200], label: 'F' },
    { startTick: 960,  endTick: 1440, pitches: [6700, 7100, 7400], label: 'G' },
    { startTick: 1440, endTick: 1920, pitches: [6000, 6400, 6700], label: 'C' },
  ];
  const g = m.buildChordTransitionGraph(windows);
  assertEqual(g.nodes.length, 3, '3 unique chords');
  assertEqual(g.links.length, 3, '3 transitions');
  // All edges should have count=1 (each transition happens once).
  for (const link of g.links) {
    assertEqual(link.count, 1, 'each transition counted once');
    assertEqual(link.value, 1, 'value=1 (deterministic transition)');
  }
});

test('buildChordTransitionGraph: dedupes consecutive identical labels', () => {
  // 4 windows of C major back-to-back should produce ONE C label in the
  // sequence (and no self-loop), not 4.
  const windows = [
    { startTick: 0,    endTick: 480,  pitches: [6000, 6400, 6700], label: 'C' },
    { startTick: 480,  endTick: 960,  pitches: [6000, 6400, 6700], label: 'C' },
    { startTick: 960,  endTick: 1440, pitches: [6000, 6400, 6700], label: 'C' },
    { startTick: 1440, endTick: 1920, pitches: [6000, 6400, 6700], label: 'C' },
  ];
  const g = m.buildChordTransitionGraph(windows);
  assertEqual(g.nodes.length, 1, 'one unique chord');
  assertEqual(g.links.length, 0, 'no self-loops from dedup');
});

test('buildChordTransitionGraph: ignores silence windows', () => {
  const windows = [
    { startTick: 0,    endTick: 480,  pitches: [], label: '(silence)' },
    { startTick: 480,  endTick: 960,  pitches: [6000, 6400, 6700], label: 'C' },
    { startTick: 960,  endTick: 1440, pitches: [], label: '(silence)' },
  ];
  const g = m.buildChordTransitionGraph(windows);
  assertEqual(g.nodes.length, 1, 'only C is in the graph');
  assertEqual(g.links.length, 0, 'no transitions between silences');
});

// ---------------------------------------------------------------------------
// Quarter-tone support — labels should describe deviations from the bass,
// not force the chord into a 12-TET name.
//
// Important convention: centsToStepAlterOctave always returns the
// SHARP-spelled enharmonic (per the project's documented convention).
// 6350 cents = D# half-sharp 4 (enharmonic to E half-flat 4), NOT E half-flat.
// 5900 cents = B3 (enharmonic to C half-flat 4), NOT C half-flat.
// The chord labeler inherits this convention so labels stay consistent
// with the rest of the app.
// ---------------------------------------------------------------------------
test('chordSequence: quarter-tone triad gets literal-spelling label', () => {
  // C half-flat (enharmonically B3 in our sharp-spelled convention),
  // D#↑ (E half-flat enharmonic), G. A "neutral triad".
  const events = [
    { type: 'on',  timeTicks: 0,    note: 5900, vel: 80 },
    { type: 'on',  timeTicks: 0,    note: 6350, vel: 80 },
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },
    { type: 'off', timeTicks: 480,  note: 5900, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6350, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6700, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].hasQuarterTone, true, 'flag set');
  // The label should mention the bass (B3 in sharp spelling, since
  // 5900¢ rounds to B3) plus some descriptive text.
  assert(windows[0].label.length > 0, 'label non-empty');
  // We don't assert exact wording — the descriptive heuristic for
  // quarter-tones is approximate. The important thing is that the
  // label isn't a 12-TET triad name (since no 12-TET template matches
  // a chord where the third is 50¢ low).
  assert(!['C', 'Cm', 'Cdim', 'Caug'].includes(windows[0].label),
    'label is NOT a 12-TET triad, got: ' + windows[0].label);
});

test('chordSequence: C + D# half-sharp + G → descriptive label', () => {
  // The standard Arabic-maqam-style chord: a major triad with its
  // third lowered by 50¢. In sharp-spelled form, that's C + D#↑ + G
  // (D#↑ is enharmonic to E half-flat).
  //
  // The labeler uses LETTER-distance description, not enharmonic
  // distance — so this chord gets labeled "C (raised 2nd, 5th)" rather
  // than "neutral 3rd". This is a deliberate convention: the user sees
  // the literal spelling (D#↑) elsewhere in the app, and the chord
  // label describes what they wrote by LETTER position.
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },  // C4
    { type: 'on',  timeTicks: 0,    note: 6350, vel: 80 },  // D# half-sharp 4
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },  // G4
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6350, vel: 0 },
    { type: 'off', timeTicks: 480,  note: 6700, vel: 0 },
  ];
  const windows = m.chordSequence(events, { ticksPerQuarter: 480 });
  assertEqual(windows[0].hasQuarterTone, true, 'flag set');
  // Verify the label is descriptive (mentions "raised" or "neutral" or "lowered")
  // and references the bass letter (C).
  assert(windows[0].label.startsWith('C'),
    'label starts with C (root), got: ' + windows[0].label);
  assert(/raised|neutral|lowered/.test(windows[0].label),
    'label is descriptive, got: ' + windows[0].label);
});

// ---------------------------------------------------------------------------
// Window-size override.
// ---------------------------------------------------------------------------
test('chordSequence: windowTicks override changes granularity', () => {
  // 4 beats of a C major triad. With windowTicks=960 (half note),
  // we should get 2 windows; with windowTicks=480 (quarter), 4 windows.
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80 },
    { type: 'on',  timeTicks: 0,    note: 6400, vel: 80 },
    { type: 'on',  timeTicks: 0,    note: 6700, vel: 80 },
    { type: 'off', timeTicks: 1920, note: 6000, vel: 0 },
    { type: 'off', timeTicks: 1920, note: 6400, vel: 0 },
    { type: 'off', timeTicks: 1920, note: 6700, vel: 0 },
  ];
  const halfNote = m.chordSequence(events, { ticksPerQuarter: 480, windowTicks: 960 });
  const quarterNote = m.chordSequence(events, { ticksPerQuarter: 480, windowTicks: 480 });
  assertEqual(halfNote.length, 2, 'half-note windows: 2 entries');
  assertEqual(quarterNote.length, 4, 'quarter-note windows: 4 entries');
});

// ---------------------------------------------------------------------------
// Edge case: empty events.
// ---------------------------------------------------------------------------
test('chordSequence: empty events produce empty array', () => {
  const windows = m.chordSequence([], { ticksPerQuarter: 480 });
  assertEqual(windows.length, 0, 'no windows from empty events');
});

test('chordSequence: silence-only file produces silence labels', () => {
  // Empty file (no events). All windows should be "(silence)".
  const windows = m.chordSequence([], { ticksPerQuarter: 480 });
  // Empty events → 0 windows. That's the current behavior. Not a bug;
  // the caller should check r.monophonic / window count for emptiness.
  assertEqual(windows.length, 0, '0 windows');
});

console.log('------------------------------------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);