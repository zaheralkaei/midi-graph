// build-example.js — generate a small public-domain .mid for the demo.
// Bach, Minuet in G (BWV Anh. 114), first 8 bars, single voice, 96 BPM.
// Output: examples/minuet.mid
//
// Hand-written MIDI bytes; no library. PPQ = 480. One track, one channel.
// Notes follow the standard G major melody.

const fs = require('fs');
const path = require('path');

// MIDI constants
const PPQ = 480;
const SET_TEMPO_META = (bpm) => {
  // 0xFF 0x51 0x03 <3 bytes microsPerQuarter>
  const m = Math.round(60_000_000 / bpm);
  return [0xff, 0x51, 0x03, (m >> 16) & 0xff, (m >> 8) & 0xff, m & 0xff];
};
const TRACK_END = [0xff, 0x2f, 0x00];
const NOTE_ON  = (n, v) => [0x90, n & 0x7f, v & 0x7f];
const NOTE_OFF = (n)    => [0x80, n & 0x7f, 0x40];

// Pitch helpers — middle C = 60 = C4
const N = {
  D4: 62, E4: 64, Fs4: 66, G4: 67, A4: 69, B4: 71,
  C5: 72, D5: 74, E5: 76, Fs5: 78, G5: 79, A5: 81, B5: 83,
};

// Note lengths in quarter notes (1.0 = quarter, 0.5 = eighth, etc.)
// Use deltas of quarter lengths * PPQ for tick counts.
const Q = PPQ;           // quarter
const H = PPQ * 2;       // half
const E = PPQ / 2;       // eighth
const DH = PPQ * 3;      // dotted half
const DQ = PPQ * 3 / 2;  // dotted quarter

// Minuet in G — first 8 bars, in G major. Public domain.
// Bar 1: D5 D5 D5  G5  Fs5 E5
// Bar 2: Fs5 Fs5 E5  D5  Cs5 B4
// Bar 3: C5 C5 B4  D5  E5 Fs5
// Bar 4: G5 A5 B5  G5
// (truncated — original continues; this is enough for a demo)
//
// Note sequence: [pitchName, lengthInQuarters]
const melody = [
  // Bar 1: D D D G  F# E  (pitches D5 D5 D5 G5 F#5 E5)
  ['D5', 1], ['D5', 1], ['D5', 1], ['G5', 1], ['Fs5', 1], ['E5', 1],
  // Bar 2: F# F# E D C# B
  ['Fs5', 1], ['Fs5', 1], ['E5', 1], ['D5', 1], ['D5', 1], ['B4', 1],
  // Bar 3: C C B D E F#
  ['C5', 1], ['C5', 1], ['B4', 1], ['D5', 1], ['E5', 1], ['Fs5', 1],
  // Bar 4: G A B G
  ['G5', 1], ['A5', 1], ['B5', 1], ['G5', 1],
  // Bar 5: D5 D5 D5 G5 Fs5 E5
  ['D5', 1], ['D5', 1], ['D5', 1], ['G5', 1], ['Fs5', 1], ['E5', 1],
  // Bar 6: Fs5 Fs5 E5 D5 Cs5 B4
  ['Fs5', 1], ['Fs5', 1], ['E5', 1], ['D5', 1], ['D5', 1], ['B4', 1],
  // Bar 7: C5 C5 B4 D5 E5 Fs5
  ['C5', 1], ['C5', 1], ['B4', 1], ['D5', 1], ['E5', 1], ['Fs5', 1],
  // Bar 8: G5 (dotted half) then final
  ['G5', 4],
];

function vlq(n) {
  // Pack n as a MIDI variable-length quantity. Always at least 1 byte.
  if (n < 0) throw new Error('negative VLQ');
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

function buildTrack() {
  const out = [];
  let lastTick = 0;

  // Set tempo at track start (96 BPM = 625000 microseconds per quarter).
  out.push(0x00, ...SET_TEMPO_META(96));

  for (const [name, lengthQ] of melody) {
    const ticks = Math.round(lengthQ * Q);
    const note = N[name];
    const onAt  = lastTick;
    const offAt = lastTick + ticks;

    // note_on at onAt with delta 0 (immediately after the previous event)
    out.push(0x00, ...NOTE_ON(note, 80));
    // note_off at offAt with delta (offAt - onAt)
    const deltaOff = offAt - onAt;
    out.push(...vlq(deltaOff), ...NOTE_OFF(note));
    lastTick = offAt;
  }

  // End of track
  out.push(0x00, ...TRACK_END);
  return Buffer.from(out);
}

function buildMidi() {
  const trackData = buildTrack();

  // Header chunk
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, // "MThd"
    0x00, 0x00, 0x00, 0x06, // length = 6
    0x00, 0x00,             // format 0 (single multi-channel track)
    0x00, 0x01,             // 1 track
    (PPQ >> 8) & 0xff, PPQ & 0xff, // division
  ]);

  // Track chunk
  const trackHeader = Buffer.from([
    0x4d, 0x54, 0x72, 0x6b, // "MTrk"
    (trackData.length >> 24) & 0xff,
    (trackData.length >> 16) & 0xff,
    (trackData.length >> 8) & 0xff,
    trackData.length & 0xff,
  ]);

  return Buffer.concat([header, trackHeader, trackData]);
}

const outDir = path.join(__dirname, '..', 'examples');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'minuet.mid');
fs.writeFileSync(outPath, buildMidi());
console.log(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);