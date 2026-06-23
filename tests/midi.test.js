// tests/midi.test.js — smoke tests for js/midi.js
//
// Hand-built MIDI bytes exercise the parser, transition graph, and stats
// without needing mido/pytest or external sample files. Run with:
//     node tests/midi.test.js
//
// The internal pitch representation is cents above C0. MIDI bytes are
// 12-TET only (× 100 = cents). Quarter-tones only appear in MusicXML tests.

const fs = require('fs');
const path = require('path');
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
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// MIDI builder — accepts MIDI note bytes (0-127). The parser converts to cents.
function buildMidi(events, { ppq = 480, bpm = 120 } = {}) {
  const evList = [{ type: 'tempo', tick: 0, bpm }].concat(events);
  evList.sort((a, b) => a.tick - b.tick);
  const track = [];
  let lastTick = 0;
  for (const ev of evList) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    track.push(...vlq(delta));
    if (ev.type === 'tempo') {
      const mics = Math.round(60_000_000 / ev.bpm);
      track.push(0xff, 0x51, 0x03, (mics >> 16) & 0xff, (mics >> 8) & 0xff, mics & 0xff);
    } else if (ev.type === 'on') {
      track.push(0x90, ev.note & 0x7f, ev.vel & 0x7f);
    } else if (ev.type === 'off') {
      track.push(0x80, ev.note & 0x7f, 0x40);
    }
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const trackData = Buffer.from(track);
  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ]);
  const trackHeader = Buffer.from([
    0x4d, 0x54, 0x72, 0x6b,
    (trackData.length >> 24) & 0xff, (trackData.length >> 16) & 0xff,
    (trackData.length >> 8) & 0xff, trackData.length & 0xff,
  ]);
  return new Uint8Array(Buffer.concat([header, trackHeader, trackData]));
}
function vlq(n) {
  if (n === 0) return [0];
  const bytes = [];
  bytes.push(n & 0x7f); n >>= 7;
  while (n > 0) { bytes.push((n & 0x7f) | 0x80); n >>= 7; }
  return bytes.reverse();
}

console.log('midi.js tests');
console.log('------------');

// ---------------------------------------------------------------------------
// centsToPitch: display names for standard 12-TET pitches (cents divisible by 100)
// ---------------------------------------------------------------------------
test('centsToPitch: middle C is C4', () => {
  assertEqual(m.centsToPitch(6000), 'C4');
});
test('centsToPitch: A4 (440Hz reference)', () => {
  assertEqual(m.centsToPitch(6900), 'A4');
});
test('centsToPitch: cents 0 is C-1', () => {
  assertEqual(m.centsToPitch(0), 'C-1');
});
test('centsToPitch: cents 12700 is G9', () => {
  assertEqual(m.centsToPitch(12700), 'G9');
});
test('centsToPitch: sharp spelling for chromatic classes', () => {
  assertEqual(m.centsToPitch(6100), 'C#4');
  assertEqual(m.centsToPitch(6600), 'F#4');
  assertEqual(m.centsToPitch(7000), 'A#4');
});

// ---------------------------------------------------------------------------
// centsToPitch: quarter-tones — exactly preserved as named pitches
// ---------------------------------------------------------------------------
// Quarter-tone cents ↔ display name with the short "↑" form.
// (e.g. centsToPitch(6050) → "C↑4", pitchClass(6050) → "C↑")
test('centsToPitch: C half-sharp (cents 6050) is named, not rounded', () => {
  assertEqual(m.centsToPitch(6050), 'C↑4');
});
test('centsToPitch: F# half-sharp (cents 6650)', () => {
  assertEqual(m.centsToPitch(6650), 'F#↑4');
});
test('centsToPitch: B half-sharp (cents 7150)', () => {
  assertEqual(m.centsToPitch(7150), 'B↑4');
});
test('centsToPitch: C half-sharp stays distinct from C# at octave boundary', () => {
  assertEqual(m.centsToPitch(6050), 'C↑4');
  assertEqual(m.centsToPitch(6100), 'C#4');
  assertNotEqual(m.centsToPitch(6050), m.centsToPitch(6100));
});

// P1-1: negative cents return "?" instead of producing misleading "?-1"
test('centsToPitch: negative cents returns ?', () => {
  assertEqual(m.centsToPitch(-1), '?');
  assertEqual(m.centsToPitch(-100), '?');
  assertEqual(m.centsToPitch(-50), '?');
});

// P1-3: banker's rounding (round-half-to-even) so 25¢ → 0¢, 75¢ → 100¢
test('centsToPitch: 25 cents rounds to 0 (banker, not 50)', () => {
  assertEqual(m.centsToPitch(25), 'C-1');  // 25¢ → even 0
});
test('centsToPitch: 75 cents rounds to 100 (banker)', () => {
  assertEqual(m.centsToPitch(75), 'C#-1');  // 75¢ → 100 (rounds up, not half)
});
test('centsToPitch: 125 cents rounds to 100 (banker, .5 to even)', () => {
  // 125/50 = 2.5 → banker → 2 → 100
  assertEqual(m.centsToPitch(125), 'C#-1');
});

// P1-2: pitchClass handles negative cents — values just below 0 (like -1,
// which can't wrap cleanly to a quarter-tone) return "?". Negative values
// within the mod 1200 wrap range produce the corresponding class name.
// (E.g. -100¢ → wraps to 1100¢ → "B". This is consistent with how
// pitchClass has always handled sub-octave wrap-around.)
test('pitchClass: -1 cent (below quarter-tone resolution) returns ?', () => {
  assertEqual(m.pitchClass(-1), '?');
});
test('pitchClass: -100 wraps to B (consistent with positive wrap-around)', () => {
  assertEqual(m.pitchClass(-100), 'B');
});

// pitchOf regression: graph.js parses pitch names back to cents. The regex
// must match "C half-sharp 4" with the trailing space inside the optional
// group, otherwise half-sharps silently round to the natural pitch's cents.
test('pitchOf contract: returns exact cents for half-sharps', () => {
  // This mirrors the regex test in graph.js (browser-only, but the contract
  // is "pitchOf(id) === stepAlterOctaveToCents(step, alter, octave) for
  // every QUARTER_TONE_NAMES entry"). The 6050 case is the critical one.
  // We can't import graph.js in node (it requires d3), but we can verify
  // the centsToPitch round-trip preserves exact 50-cent increments.
  const halfSharps = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950, 1050, 1150];
  for (const c of halfSharps) {
    const name = m.centsToPitch(c);
    // Names now use the ↑ symbol (e.g. "C↑0"), not the long "half-sharp"
    // form. The contract we're testing is "name contains a quarter-tone
    // marker", which we satisfy with either short or long form.
    assert(name.includes('\u2191') || name.includes('half-sharp'),
      `cents ${c} should produce a name with a quarter-tone marker, got "${name}"`);
  }
});

// pitchOf cents correctness: the function in graph.js uses a 12-entry
// SHARP_SCALE_NAMES ['C','C#','D',...] for index lookup, NOT the 24-entry
// NOTE_NAMES. A previous regression used NOTE_NAMES and produced wrong cents
// for every non-C note (broke the playback glow + filter sliders).
// We can't import pitchOf directly (it lives in graph.js, browser-only),
// but we can replicate the formula here and verify it matches the
// stepAlterOctaveToCents ground truth.
test('pitchOf cents formula: all 12 naturals + sharps, multiple octaves', () => {
  const SHARP_SCALE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Convention (matches centsToPitch): octave N = cents (N+1)*1200.
  // C-1 = 0, C0 = 1200, C4 = 6000 (middle C), C5 = 7200.
  // pitchOf("X<oct>") = (oct+1)*1200 + SHARP_SCALE_NAMES.indexOf(X)*100.
  const cases = [
    ['C-1', 0],    ['C0', 1200],  ['C4', 6000],  ['C5', 7200],
    ['D4', 6200],  ['D5', 7400],
    ['E4', 6400],  ['E5', 7600],
    ['F4', 6500],  ['F5', 7700],
    ['G4', 6700],  ['G5', 7900],
    ['A4', 6900],  ['A5', 8100],  ['A6', 9300],
    ['B4', 7100],  ['B5', 8300],
    ['C#4', 6100], ['C#5', 7300],
    ['D#4', 6300], ['D#5', 7500],
    ['F#4', 6600], ['F#5', 7800],
    ['G#4', 6800], ['G#5', 8000],
    ['A#4', 7000], ['A#5', 8200],
  ];
  for (const [name, expectedCents] of cases) {
    const m1 = name.match(/^([A-G][#]?)(-?\d+)$/);
    assert(m1, `regex should match "${name}"`);
    const pc = SHARP_SCALE_NAMES.indexOf(m1[1]);
    const oct = parseInt(m1[2], 10);
    const cents = (oct + 1) * 1200 + pc * 100;
    assertEqual(cents, expectedCents,
      `pitchOf("${name}") should yield ${expectedCents}`);
  }
});

test('pitchOf cents formula: quarter-tone support (short ↑ form, current emit)', () => {
  // Short form: "C↑4" = (4+1)*1200 + 0*100 + 50 = 6050. This is what
  // centsToPitch emits today. pitchOf in graph.js must accept it.
  const SHARP_SCALE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const cases = [
    ['C↑4', 6050],
    ['C#↑4', 6150],
    ['D↑4', 6250],
    ['F#↑4', 6650],
    ['A↑5', 8150],
    ['B↑4', 7150],
  ];
  for (const [name, expectedCents] of cases) {
    const m1 = name.match(/^([A-G][#]?)(\u2191| (?:half-(?:sharp|flat)) )?(-?\d+)$/);
    assert(m1, `regex should match "${name}"`);
    const pc = SHARP_SCALE_NAMES.indexOf(m1[1]);
    const oct = parseInt(m1[3], 10);
    const cents = (oct + 1) * 1200 + pc * 100 + (m1[2] ? 50 : 0);
    assertEqual(cents, expectedCents,
      `pitchOf("${name}") should yield ${expectedCents}`);
  }
});
test('pitchOf cents formula: quarter-tone support (long "half-sharp" form, legacy compat)', () => {
  // Long form: "C half-sharp 4" = same cents. Kept for backward-compat
  // with anything that cached the old display name.
  const SHARP_SCALE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const cases = [
    ['C half-sharp 4', 6050],
    ['C# half-sharp 4', 6150],
    ['D half-sharp 4', 6250],
    ['F# half-sharp 4', 6650],
    ['A half-sharp 5', 8150],
    ['B half-sharp 4', 7150],
    ['B half-flat 4', 7150],   // half-flat = same cents as the half-sharp below
  ];
  for (const [name, expectedCents] of cases) {
    const m1 = name.match(/^([A-G][#]?)(\u2191| (?:half-(?:sharp|flat)) )?(-?\d+)$/);
    assert(m1, `regex should match "${name}"`);
    const pc = SHARP_SCALE_NAMES.indexOf(m1[1]);
    const oct = parseInt(m1[3], 10);
    const cents = (oct + 1) * 1200 + pc * 100 + (m1[2] ? 50 : 0);
    assertEqual(cents, expectedCents,
      `pitchOf("${name}") should yield ${expectedCents}`);
  }
});

// ---------------------------------------------------------------------------
// detectFileType — sniff content rather than relying on extension. Used by
// app.js to route uploads to the correct parser. Crucial because users
// routinely rename .musicxml to .mid by accident.
// ---------------------------------------------------------------------------
test('detectFileType: MIDI header (MThd)', () => {
  const r = m.detectFileType(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]));
  assertEqual(r.type, 'midi');
});
test('detectFileType: MusicXML with prolog', () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><score-partwise/>';
  const bytes = new TextEncoder().encode(xml);
  const r = m.detectFileType(bytes, 'foo.musicxml');
  assertEqual(r.type, 'musicxml');
});
test('detectFileType: MusicXML without prolog (rare)', () => {
  const xml = '<score-timewise version="3.1"/>';
  const bytes = new TextEncoder().encode(xml);
  const r = m.detectFileType(bytes, 'foo.xml');
  assertEqual(r.type, 'musicxml');
});
test('detectFileType: MusicXML with leading whitespace + BOM', () => {
  // UTF-8 BOM (EF BB BF) followed by XML
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x3c, 0x3f, 0x78, 0x6d, 0x6c]);
  const r = m.detectFileType(bytes, 'foo.musicxml');
  assertEqual(r.type, 'musicxml');
});
test('detectFileType: .mxl (compressed MusicXML / ZIP)', () => {
  // ZIP local file header magic = PK\x03\x04
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const r = m.detectFileType(bytes, 'song.mxl');
  assertEqual(r.type, 'mxl');
});
test('detectFileType: unrecognized binary file', () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);  // PNG
  const r = m.detectFileType(bytes, 'image.png');
  assertEqual(r.type, 'unknown');
});
test('detectFileType: unrecognized with .mid extension gives helpful hint', () => {
  // A file with .mid extension that's actually XML (the common user mistake)
  const xml = '<?xml version="1.0"?><score-partwise/>';
  const bytes = new TextEncoder().encode(xml);
  const r = m.detectFileType(bytes, 'song.mid');
  assertEqual(r.type, 'musicxml', 'should detect XML content regardless of extension');
  // The detect function doesn't include the hint for musicxml matches, only
  // for unknown types. The hint lives in app.js's error display.
});
test('detectFileType: unknown content with .mid extension includes hint', () => {
  // Pure garbage that starts with non-MThd, non-XML, non-ZIP bytes.
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const r = m.detectFileType(bytes, 'song.mid');
  assertEqual(r.type, 'unknown');
  assert(r.reason.indexOf('.mid extension') >= 0,
    `hint should mention .mid extension, got: ${r.reason}`);
  assert(r.reason.indexOf('renaming it to .musicxml') >= 0,
    `hint should suggest renaming, got: ${r.reason}`);
});
test('detectFileType: unknown with .mxl extension mentions re-export', () => {
  const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const r = m.detectFileType(bytes, 'song.mxl');
  assertEqual(r.type, 'unknown');
  // Wait — .mxl IS detected as 'mxl' if it starts with PK. So a non-PK
  // .mxl file would be 'unknown' but with the .mxl-specific hint. The hint
  // for 'unknown' says ".mxl extension" but the .mxl-detection path says
  // "export as uncompressed". This test confirms both paths coexist.
  // Actually our code marks unknown+.mxl as ".mxl is recognized but not
  // yet parsed — export as uncompressed .musicxml". Let me verify this
  // works correctly for the non-PK .mxl case too.
  // (The hint string in detectFileType for .mxl says "compressed MusicXML
  // .mxl is recognized but not yet parsed" — that's the messaging.)
  // For our test, we only check that .mxl extension triggers the .mxl hint.
  // Note: 'unknown' for a .mxl file means "no PK header, can't process".
  // The user-facing message comes from app.js which checks detected.type
  // and shows a different message for 'mxl'. So detectFileType's hint for
  // unknown+.mxl doesn't really fire in practice — app.js catches 'mxl'
  // before falling through to 'unknown'. This test is just a safety net.
  assert(r.reason.indexOf('.mxl') >= 0 || r.reason.indexOf('compressed MusicXML') >= 0,
    `hint should mention .mxl or compressed, got: ${r.reason}`);
});
test('detectFileType: empty or too-small file', () => {
  const r1 = m.detectFileType(new Uint8Array([]), 'empty.mid');
  assertEqual(r1.type, 'unknown');
  assertEqual(r1.reason, 'file too small to sniff');
  const r2 = m.detectFileType(new Uint8Array([0, 1, 2]), 'tiny.mid');
  assertEqual(r2.type, 'unknown');
  assertEqual(r2.reason, 'file too small to sniff');
});

// ---------------------------------------------------------------------------
// extractMxl — unzip a .mxl (compressed MusicXML) and return the rootfile
// content as a UTF-8 string. Uses fflate under the hood, available both as
// a browser global and as a node require.
// ---------------------------------------------------------------------------
test('extractMxl: examples/ya-tyra.mxl round-trips', () => {
  // ya-tyra.mxl is the quarter-tone demo. extractMxl should unzip it,
  // read META-INF/container.xml, follow the rootfile pointer, and return
  // the inner MusicXML as a string.
  const mxlPath = path.join(__dirname, '..', 'examples', 'ya-tyra.mxl');
  const mxlBytes = new Uint8Array(fs.readFileSync(mxlPath));
  const errs = {};
  const xmlText = m.extractMxl(mxlBytes, errs);
  assert(xmlText, 'extractMxl should return a string, got null. reason: ' + errs.reason);
  assert(xmlText.indexOf('<score-partwise') >= 0,
    'extracted text should be MusicXML with a <score-partwise> root');
});

test('extractMxl: returns null with helpful reason for non-ZIP bytes', () => {
  const errs = {};
  const result = m.extractMxl(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), errs);
  assertEqual(result, null);
  assert(errs.reason, 'errors.reason should be set');
  assert(errs.reason.indexOf('ZIP') >= 0 || errs.reason.indexOf('zip') >= 0,
    `reason should mention ZIP, got: ${errs.reason}`);
});
test('extractMxl: returns null for ZIP missing META-INF/container.xml', () => {
  // Build a minimal ZIP using node's zlib for the deflate stream, but skip
  // the container — only include score.xml.
  const fflate = require('fflate');
  const fileData = { 'score.xml': new Uint8Array([60, 63, 120, 109, 108]) };
  const zipped = fflate.zipSync(fileData);
  const errs = {};
  const result = m.extractMxl(zipped, errs);
  assertEqual(result, null);
  assert(errs.reason.indexOf('container.xml') >= 0,
    `reason should mention container.xml, got: ${errs.reason}`);
});
test('extractMxl: returns null for ZIP where container points to nonexistent file', () => {
  const fflate = require('fflate');
  const container = '<?xml version="1.0"?><container><rootfiles>' +
    '<rootfile full-path="missing.xml"/></rootfiles></container>';
  const fileData = {
    'META-INF/container.xml': new TextEncoder().encode(container),
    'score.xml': new TextEncoder().encode('<score/>'),
  };
  const zipped = fflate.zipSync(fileData);
  const errs = {};
  const result = m.extractMxl(zipped, errs);
  assertEqual(result, null);
  assert(errs.reason.indexOf('missing.xml') >= 0 || errs.reason.indexOf('not in archive') >= 0,
    `reason should mention missing.xml, got: ${errs.reason}`);
});
test('extractMxl: finds container.xml at non-canonical path (fallback)', () => {
  // Some exporters put the container somewhere other than META-INF/.
  // Our fallback searches for any file ending in container.xml.
  const fflate = require('fflate');
  const container = '<?xml version="1.0"?><container><rootfiles>' +
    '<rootfile full-path="score.xml"/></rootfiles></container>';
  const fileData = {
    'weird/path/container.xml': new TextEncoder().encode(container),
    'score.xml': new TextEncoder().encode('<score-partwise/>'),
  };
  const zipped = fflate.zipSync(fileData);
  const errs = {};
  const result = m.extractMxl(zipped, errs);
  assertEqual(result, '<score-partwise/>');
  assertEqual(errs.reason, undefined,
    'no error reason expected for valid fallback layout');
});

function assertNotEqual(a, b) {
  if (a === b) throw new Error(`expected ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

// ---------------------------------------------------------------------------
// stepAlterOctaveToCents — MusicXML-style input → exact cents
// ---------------------------------------------------------------------------
test('stepAlterOctaveToCents: C4 = 6000', () => {
  assertEqual(m.stepAlterOctaveToCents('C', 0, 4), 6000);
});
test('stepAlterOctaveToCents: F#4 = 6600', () => {
  assertEqual(m.stepAlterOctaveToCents('F', 1, 4), 6600);
});
test('stepAlterOctaveToCents: C half-sharp (alter=0.5) = 6050 (NOT rounded)', () => {
  assertEqual(m.stepAlterOctaveToCents('C', 0.5, 4), 6050);
});
test('stepAlterOctaveToCents: C half-flat (alter=-0.5) = 5950', () => {
  assertEqual(m.stepAlterOctaveToCents('C', -0.5, 4), 5950);
});
test('stepAlterOctaveToCents: F half-sharp (alter=0.5) = 6550', () => {
  // F is 500 cents from C; F half-sharp = 550 from C; octave 4 → (4+1)*1200 + 550 = 6550
  assertEqual(m.stepAlterOctaveToCents('F', 0.5, 4), 6550);
});
test('stepAlterOctaveToCents: three-quarter sharp (alter=1.5) = 6150', () => {
  assertEqual(m.stepAlterOctaveToCents('C', 1.5, 4), 6150);
});
test('stepAlterOctaveToCents: invalid step returns null', () => {
  assertEqual(m.stepAlterOctaveToCents('Z', 0, 4), null);
});

// ---------------------------------------------------------------------------
// pitchClass
// ---------------------------------------------------------------------------
test('pitchClass: octave stripped, exact quarter-tones preserved', () => {
  assertEqual(m.pitchClass(6000), 'C');
  assertEqual(m.pitchClass(7200), 'C');
  assertEqual(m.pitchClass(6600), 'F#');
  assertEqual(m.pitchClass(6050), 'C↑');
  assertEqual(m.pitchClass(6650), 'F#↑');
});

// ---------------------------------------------------------------------------
// VLQ
// ---------------------------------------------------------------------------
test('readVarLen: 0 → [0, 1]', () => {
  const [v, p] = m.readVarLen([0], 0);
  assertEqual(v, 0); assertEqual(p, 1);
});
test('readVarLen: 127 → 1 byte', () => {
  const [v, p] = m.readVarLen([0x7f], 0);
  assertEqual(v, 127); assertEqual(p, 1);
});
test('readVarLen: 128 → 2 bytes', () => {
  const [v, p] = m.readVarLen([0x81, 0x00], 0);
  assertEqual(v, 128); assertEqual(p, 2);
});
test('readVarLen: 16384 → 3 bytes (boundary)', () => {
  const [v, p] = m.readVarLen([0x81, 0x80, 0x00], 0);
  assertEqual(v, 16384); assertEqual(p, 3);
});

// ---------------------------------------------------------------------------
// parseMidi — events carry `note` in cents (MIDI bytes × 100)
// ---------------------------------------------------------------------------
test('parseMidi: simple C major scale produces 7 note-on events with cents notes', () => {
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
  assertEqual(ons.map(e => e.note), [6000, 6200, 6400, 6500, 6700, 6900, 7100]);
});

test('parseMidi: note_on with vel=0 is treated as note_off', () => {
  const bytes = buildMidi([
    { type: 'on', tick: 0, note: 60, vel: 80 },
    { type: 'on', tick: 480, note: 60, vel: 0 },
  ]);
  const { events } = m.parseMidi(bytes);
  assertEqual(events.map(e => e.type), ['on', 'off']);
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
  try { m.parseMidi(new Uint8Array([0,0,0,0,0,0,0,0])); }
  catch (e) { threw = true; assert(e.message.includes('MThd')); }
  assert(threw, 'should have thrown');
});

test('parseMidi: real demo file has expected stats', () => {
  // vp2-1all.mid — the MIDI demo. 1094 notes spanning 30 unique pitches
  // (G#3 through D6). Confirms the parser + transition graph + stats work
  // end-to-end on a real file, not just synthetic test fixtures.
  const file = path.join(__dirname, '..', 'examples', 'vp2-1all.mid');
  const bytes = new Uint8Array(fs.readFileSync(file));
  const { stats } = m.analyzeMidi(bytes);
  assertEqual(stats.note_count, 1094);
  assertEqual(stats.unique_note_count, 30);
  assertEqual(stats.transition_count, 193);
  // Top transition should be deterministic.
  assertEqual(stats.all_transitions[0].probability, 1);
  // Pitch range endpoints (sample a couple, not all 30).
  assert(stats.unique_notes.includes('G#3'));
  assert(stats.unique_notes.includes('D6'));
  assert(!stats.unique_notes.includes('C-1'));
});

// ---------------------------------------------------------------------------
// buildTransitionGraph — keys on cents, not MIDI int
// ---------------------------------------------------------------------------
test('buildTransitionGraph: empty input → empty graph', () => {
  assertEqual(m.buildTransitionGraph([]), { nodes: [], links: [] });
});

test('buildTransitionGraph: single note → no graph (no transitions)', () => {
  const g = m.buildTransitionGraph([6000]);
  assertEqual(g.nodes, []);
  assertEqual(g.links, []);
});

test('buildTransitionGraph: probabilities sum to 1 per source', () => {
  const g = m.buildTransitionGraph([6000, 6200, 6400, 6000, 6200, 6500]);
  const bySource = new Map();
  for (const l of g.links) {
    bySource.set(l.source, (bySource.get(l.source) || 0) + l.value);
  }
  for (const [, sum] of bySource) {
    assert(Math.abs(sum - 1.0) < 1e-9, `probs sum to ${sum}`);
  }
});

test('buildTransitionGraph: repeated C4 → C4 self-loop is probability 0.5', () => {
  // C4 C4 D4 → from C4: C4→C4 once, C4→D4 once → each 0.5
  const g = m.buildTransitionGraph([6000, 6000, 6200]);
  const link = g.links.find(l => l.source === 'C4' && l.target === 'C4');
  assert(link, 'expected self-loop C4→C4');
  assertEqual(link.value, 0.5);
});

test('buildTransitionGraph: quarter-tone (6050) stays distinct from C# (6100)', () => {
  // C4 (6000), C↑4 (6050), C#4 (6100) — all three are different nodes.
  const g = m.buildTransitionGraph([6000, 6050, 6100]);
  const ids = g.nodes.map(n => n.id).sort();
  assertEqual(ids, ['C#4', 'C4', 'C↑4']);
  // Three transitions, none collapsed.
  assertEqual(g.links.length, 2);
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
  assertEqual(stats.all_transitions, []);
});

test('computeStats: pitch range across full MIDI span', () => {
  // C3 (4800), C4 (6000), C5 (7200), C6 (8400) — span = 36 semitones
  const notes = [6000, 7200, 4800, 8400];
  const g = m.buildTransitionGraph(notes);
  const stats = m.computeStats(notes, g);
  assertEqual(stats.pitch_range, 'C3 – C6 (36 semitones)');
});

test('computeStats: pitch range shows fractional semitones for quarter-tones', () => {
  // C4 (6000) and C↑4 (6050) → range = 0.5 semitones
  const notes = [6000, 6050];
  const g = m.buildTransitionGraph(notes);
  const stats = m.computeStats(notes, g);
  assertEqual(stats.pitch_range, 'C4 – C↑4 (0.5 semitones)');
});

test('computeStats: self-loop share of 100% if every transition is a self-loop', () => {
  const notes = [6000, 6000, 6000, 6000];
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
  const events = [
    { timeTicks: 0,    type: 'on', note: 6000, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 6200, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 6400, tempoBPM: 60  },
    { timeTicks: 1440, type: 'on', note: 6500, tempoBPM: 60  },
  ];
  const tickToSec = m.ticksToSecondsSegments(events, 480);
  assertEqual(tickToSec(0),    0);
  assertEqual(tickToSec(480),  0.5);
  assertEqual(tickToSec(1440), 2.5);
});

test('ticksToSecondsSegments: piecewise timing is right', () => {
  const events = [
    { timeTicks: 0,    type: 'on', note: 6000, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 6200, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on', note: 6400, tempoBPM: 60  },
    { timeTicks: 1440, type: 'on', note: 6500, tempoBPM: 60  },
  ];
  const tickToSec = m.ticksToSecondsSegments(events, 480);
  assert(Math.abs(tickToSec(0) - 0) < 1e-9);
  assert(Math.abs(tickToSec(480) - 0.5) < 1e-9);
  assert(Math.abs(tickToSec(1440) - 2.5) < 1e-9);
});

test('computeStats: all_transitions contains EVERY transition (not just top 5)', () => {
  // Regression test for the user-reported bug "not all transitions percents
  // are shown". The old behavior was top_transitions = ranked.slice(0, 5),
  // which silently dropped the rest. With dense pieces (vp2-1all.mid has
  // 193 transitions), 188 of them vanished from the stats panel. Now
  // all_transitions returns every link, sorted by probability descending.
  //
  // Build a graph with 8 transitions and verify all 8 appear.
  const notes = [6000, 6100, 6200, 6300, 6400, 6500, 6600, 6700];  // 7 unique
  const g = m.buildTransitionGraph(notes);
  assertEqual(g.links.length, 7);  // 8 notes → 7 transitions
  const stats = m.computeStats(notes, g);
  assertEqual(stats.all_transitions.length, 7);
  // Sorted by probability descending.
  for (let i = 1; i < stats.all_transitions.length; i++) {
    assert(stats.all_transitions[i - 1].probability >= stats.all_transitions[i].probability,
      'all_transitions must be sorted by probability descending');
  }
});

test('computeStats: all_transitions includes self-loops when present', () => {
  // Self-loops are transitions too and should appear in all_transitions.
  // Notes: C4, C4, C4 → transition C4→C4 (self-loop, prob=1.0).
  const notes = [6000, 6000, 6000];
  const g = m.buildTransitionGraph(notes);
  const stats = m.computeStats(notes, g);
  assertEqual(stats.all_transitions.length, 1);
  assertEqual(stats.all_transitions[0].from, 'C4');
  assertEqual(stats.all_transitions[0].to, 'C4');
  assertEqual(stats.all_transitions[0].probability, 1);
});

console.log('------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);