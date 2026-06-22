// tests/midi.test.js — smoke tests for js/midi.js
//
// Hand-built MIDI bytes exercise the parser, transition graph, and stats
// without needing mido/pytest or external sample files. Run with:
//     node tests/midi.test.js
//
// Exit code 0 on success, 1 on any failure.

const fs = require('fs');
const path = require('path');
const m = require('../js/midi.js');

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok    ' + name);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || ''} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---------------------------------------------------------------------------
// Helper: build a minimal format-0 MIDI file from a list of events.
// Each event: { type: 'on'|'off'|'tempo', tick, note?, vel?, bpm? }
// Delta times are computed automatically.
// ---------------------------------------------------------------------------
function buildMidi(events, { ppq = 480, bpm = 120 } = {}) {
  // Set tempo at start
  const evList = [{ type: 'tempo', tick: 0, bpm }].concat(events);
  evList.sort((a, b) => a.tick - b.tick);

  const track = [];
  let lastTick = 0;
  for (const ev of evList) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    track.push(...vlq(delta));
    if (ev.type === 'tempo') {
      const m = Math.round(60_000_000 / ev.bpm);
      track.push(0xff, 0x51, 0x03, (m >> 16) & 0xff, (m >> 8) & 0xff, m & 0xff);
    } else if (ev.type === 'on') {
      track.push(0x90, ev.note & 0x7f, ev.vel & 0x7f);
    } else if (ev.type === 'off') {
      track.push(0x80, ev.note & 0x7f, 0x40);
    }
  }
  // End of track
  track.push(0x00, 0xff, 0x2f, 0x00);

  const trackData = Buffer.from(track);
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64,
    0x00, 0x00, 0x00, 0x06,
    0x00, 0x00,
    0x00, 0x01,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ]);
  const trackHeader = Buffer.from([
    0x4d, 0x54, 0x72, 0x6b,
    (trackData.length >> 24) & 0xff,
    (trackData.length >> 16) & 0xff,
    (trackData.length >> 8) & 0xff,
    trackData.length & 0xff,
  ]);
  return new Uint8Array(Buffer.concat([header, trackHeader, trackData]));
}

function vlq(n) {
  if (n === 0) return [0];
  const bytes = [];
  bytes.push(n & 0x7f);
  n >>= 7;
  while (n > 0) {
    bytes.push((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes.reverse();
}

console.log('midi.js tests');
console.log('------------');

// ---------------------------------------------------------------------------
// pitch / pitchClass
// ---------------------------------------------------------------------------
test('midiToPitch: middle C is C4', () => {
  assertEqual(m.midiToPitch(60), 'C4');
});
test('midiToPitch: A4 is 440Hz reference', () => {
  assertEqual(m.midiToPitch(69), 'A4');
});
test('midiToPitch: note 0 is C-1', () => {
  assertEqual(m.midiToPitch(0), 'C-1');
});
test('midiToPitch: note 127 is G9', () => {
  assertEqual(m.midiToPitch(127), 'G9');
});
test('midiToPitch: sharp spelling for chromatic classes', () => {
  assertEqual(m.midiToPitch(61), 'C#4');
  assertEqual(m.midiToPitch(66), 'F#4');
  assertEqual(m.midiToPitch(70), 'A#4');
});
test('pitchClass: octave stripped', () => {
  assertEqual(m.pitchClass(60), 'C');
  assertEqual(m.pitchClass(72), 'C');
  assertEqual(m.pitchClass(66), 'F#');
});

// ---------------------------------------------------------------------------
// VLQ
// ---------------------------------------------------------------------------
test('readVarLen: 0 → [0, 1]', () => {
  const [v, p] = m.readVarLen([0], 0);
  assertEqual(v, 0);
  assertEqual(p, 1);
});
test('readVarLen: 127 → 1 byte', () => {
  const [v, p] = m.readVarLen([0x7f], 0);
  assertEqual(v, 127);
  assertEqual(p, 1);
});
test('readVarLen: 128 → 2 bytes', () => {
  const [v, p] = m.readVarLen([0x81, 0x00], 0);
  assertEqual(v, 128);
  assertEqual(p, 2);
});
test('readVarLen: 16384 → 3 bytes (boundary)', () => {
  // 16384 = 0x4000 → bytes 0x81 0x80 0x00
  const [v, p] = m.readVarLen([0x81, 0x80, 0x00], 0);
  assertEqual(v, 16384);
  assertEqual(p, 3);
});

// ---------------------------------------------------------------------------
// parseMidi
// ---------------------------------------------------------------------------
test('parseMidi: simple C major scale produces 7 note-on events', () => {
  // C4 D4 E4 F4 G4 A4 B4 quarter notes
  const bytes = buildMidi([
    { type: 'on', tick: 0, note: 60, vel: 80 },
    { type: 'on', tick: 480, note: 62, vel: 80 },
    { type: 'on', tick: 960, note: 64, vel: 80 },
    { type: 'on', tick: 1440, note: 65, vel: 80 },
    { type: 'on', tick: 1920, note: 67, vel: 80 },
    { type: 'on', tick: 2400, note: 69, vel: 80 },
    { type: 'on', tick: 2880, note: 71, vel: 80 },
  ]);
  const { events, ticksPerQuarter } = m.parseMidi(bytes);
  assertEqual(ticksPerQuarter, 480);
  const ons = events.filter(e => e.type === 'on');
  assertEqual(ons.length, 7);
  assertEqual(ons.map(e => e.note), [60, 62, 64, 65, 67, 69, 71]);
});

test('parseMidi: note_on with vel=0 is treated as note_off', () => {
  const bytes = buildMidi([
    { type: 'on', tick: 0, note: 60, vel: 80 },
    { type: 'on', tick: 480, note: 60, vel: 0 },  // "off" via vel=0
  ]);
  const { events } = m.parseMidi(bytes);
  const types = events.map(e => e.type);
  assertEqual(types, ['on', 'off']);
});

test('parseMidi: tempo change is recorded on subsequent events', () => {
  const bytes = buildMidi([
    { type: 'tempo', tick: 0, bpm: 120 },
    { type: 'on', tick: 0, note: 60, vel: 80 },
    { type: 'tempo', tick: 480, bpm: 60 },
    { type: 'on', tick: 480, note: 64, vel: 80 },
  ]);
  const { events } = m.parseMidi(bytes);
  const ons = events.filter(e => e.type === 'on');
  assertEqual(ons[0].tempoBPM, 120);
  assertEqual(ons[1].tempoBPM, 60);
});

test('parseMidi: rejects non-MThd file', () => {
  let threw = false;
  try {
    m.parseMidi(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
  } catch (e) {
    threw = true;
    assert(e.message.includes('MThd'), 'expected MThd error');
  }
  assert(threw, 'should have thrown');
});

test('parseMidi: real minuet file has expected stats', () => {
  const file = path.join(__dirname, '..', 'examples', 'minuet.mid');
  const bytes = new Uint8Array(fs.readFileSync(file));
  const { graph, stats } = m.analyzeMidi(bytes);
  assertEqual(stats.note_count, 41);
  assertEqual(stats.unique_note_count, 8);
  assertEqual(stats.transition_count, 18);
  assertEqual(stats.self_loop_count, 3);
  // The unique pitches are exactly the ones in the melody.
  const expectedPitches = ['A5', 'B4', 'B5', 'C5', 'D5', 'E5', 'F#5', 'G5'];
  assertEqual(stats.unique_notes.sort(), expectedPitches.sort());
  // No spurious low notes from undefined lookups.
  assert(!stats.unique_notes.includes('C-1'), 'C-1 must not appear in a G-major minuet');
});

// ---------------------------------------------------------------------------
// buildTransitionGraph
// ---------------------------------------------------------------------------
test('buildTransitionGraph: empty input → empty graph', () => {
  const g = m.buildTransitionGraph([]);
  assertEqual(g.nodes, []);
  assertEqual(g.links, []);
});

test('buildTransitionGraph: single note → empty graph (no transitions to count)', () => {
  // A single note has no outgoing transitions, so it gets dropped. This is
  // intentional: the graph is about transitions, not just pitches.
  const g = m.buildTransitionGraph([60]);
  assertEqual(g.nodes, []);
  assertEqual(g.links, []);
});

test('buildTransitionGraph: probabilities sum to 1 per source', () => {
  const g = m.buildTransitionGraph([60, 62, 64, 60, 62, 65]);
  const bySource = new Map();
  for (const l of g.links) {
    bySource.set(l.source, (bySource.get(l.source) || 0) + l.value);
  }
  for (const [src, sum] of bySource) {
    assert(Math.abs(sum - 1.0) < 1e-9, `probs for ${src} sum to ${sum}, not 1`);
  }
});

test('buildTransitionGraph: counts repeated transitions correctly', () => {
  // A A B → two outgoing from A: A→A once, A→B once → each probability 0.5
  const g = m.buildTransitionGraph([60, 60, 62]);
  const link = g.links.find(l => l.source === 'C4' && l.target === 'C4');
  assert(link, 'expected self-loop C4→C4');
  assertEqual(link.value, 0.5);
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------
test('computeStats: empty notes → safe defaults', () => {
  const stats = m.computeStats([], { nodes: [], links: [] });
  assertEqual(stats.note_count, 0);
  assertEqual(stats.unique_note_count, 0);
  assertEqual(stats.transition_count, 0);
  assertEqual(stats.self_loop_count, 0);
  assertEqual(stats.self_loop_share, 0);
  assertEqual(stats.pitch_range, '—');
  assertEqual(stats.top_transitions, []);
});

test('computeStats: pitch range across full MIDI span', () => {
  const notes = [60, 72, 48, 84];
  const g = m.buildTransitionGraph(notes);
  const stats = m.computeStats(notes, g);
  assertEqual(stats.pitch_range, 'C3 – C6 (36 semitones)');
});

test('computeStats: self-loop share of 100% if every transition is a self-loop', () => {
  const notes = [60, 60, 60, 60];
  const g = m.buildTransitionGraph(notes);
  const stats = m.computeStats(notes, g);
  assertEqual(stats.self_loop_share, 1.0);
});

// ---------------------------------------------------------------------------
// ticksToSeconds
// ---------------------------------------------------------------------------
test('ticksToSeconds: 120 BPM, 480 PPQ, 480 ticks = 0.5s', () => {
  assertEqual(m.ticksToSeconds(480, 120, 480), 0.5);
});

test('ticksToSeconds: 60 BPM, 480 PPQ, 960 ticks = 2.0s', () => {
  assertEqual(m.ticksToSeconds(960, 60, 480), 2.0);
});

test('ticksToSecondsSegments: re-bases correctly across tempo change', () => {
  // Segment 1: tick 0..480 at 120 BPM. At 120 BPM, 1 quarter (480 ticks) = 0.5s.
  // Segment 2: tick 480..1440 at 60 BPM. At 60 BPM, 960 ticks (2 quarters) = 2.0s.
  // Total time at tick 1440 = 0.5 + 2.0 = 2.5 seconds.
  const events = [
    { timeTicks: 0,    type: 'on', note: 60, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 62, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 64, tempoBPM: 60  },
    { timeTicks: 1440, type: 'on', note: 65, tempoBPM: 60  },
  ];
  const tickToSec = m.ticksToSecondsSegments(events, 480);
  assertEqual(tickToSec(0),    0);
  assertEqual(tickToSec(480),  0.5);
  assertEqual(tickToSec(1440), 2.5);
});

// (The assertions above depend on the exact segment table; let's just verify a few key values)
test('ticksToSecondsSegments: piecewise timing is right', () => {
  const events = [
    { timeTicks: 0,    type: 'on', note: 60, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 62, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 64, tempoBPM: 60  },
    { timeTicks: 1440, type: 'on', note: 65, tempoBPM: 60  },
  ];
  const tickToSec = m.ticksToSecondsSegments(events, 480);
  // 120 BPM segment: tick 0..480 → 0.5 second.
  assert(Math.abs(tickToSec(0) - 0) < 1e-9);
  assert(Math.abs(tickToSec(480) - 0.5) < 1e-9);
  // 60 BPM segment starts at tick 480 (0.5 seconds in).
  // At tick 1440 (960 ticks later at 60 BPM) = 2 more seconds = 2.5 total.
  assert(Math.abs(tickToSec(1440) - 2.5) < 1e-9);
});

// ---------------------------------------------------------------------------
console.log('------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);