// tests/musicxml.test.js — smoke tests for js/musicxml.js
//
// Wires up @xmldom/xmldom's DOMParser so the same source runs in both node
// and the browser. Quarter-tone tests live here because MIDI can't represent
// them — only MusicXML carries alter in fractions.

const { DOMParser } = require('@xmldom/xmldom');
const M = require('../js/midi.js');
const xml = require('../js/musicxml.js');

M.__xmlDomParser = { parseFromString: (text, type) => new DOMParser().parseFromString(text, type) };

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok    ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name); console.log('        ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || ''} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

console.log('musicxml.js tests');
console.log('-----------------');

// ---------------------------------------------------------------------------
// pitchToCents — delegates to midi.js, so quarter-tones are exact
// ---------------------------------------------------------------------------
test('pitchToCents: C4 → 6000', () => assertEqual(xml.pitchToCents('C', 0, 4), 6000));
test('pitchToCents: A4 → 6900', () => assertEqual(xml.pitchToCents('A', 0, 4), 6900));
test('pitchToCents: F#4 (alter=1) → 6600', () => assertEqual(xml.pitchToCents('F', 1, 4), 6600));
test('pitchToCents: Bb4 (alter=-1) → 7000', () => assertEqual(xml.pitchToCents('B', -1, 4), 7000));

// Quarter-tones: NOT rounded — preserved exactly.
test('pitchToCents: C half-sharp (alter=0.5) → 6050 (NOT 6100)', () => {
  assertEqual(xml.pitchToCents('C', 0.5, 4), 6050);
});
test('pitchToCents: C half-flat (alter=-0.5) → 5950 (NOT 6000)', () => {
  assertEqual(xml.pitchToCents('C', -0.5, 4), 5950);
});
test('pitchToCents: F half-sharp (alter=0.5) → 6550 (NOT 6600)', () => {
  // F is 500 cents from C; F half-sharp = 550; octave 4 = (4+1)*1200 + 550 = 6550
  assertEqual(xml.pitchToCents('F', 0.5, 4), 6550);
});
test('pitchToCents: D + alter=0.5 (D half-sharp, between D and D#) → 6250', () => {
  // D is 200 cents from C; D half-sharp = 250; octave 5 = (5+1)*1200 + 250 = 7450
  assertEqual(xml.pitchToCents('D', 0.5, 5), 7450);
});
test('pitchToCents: invalid step returns null', () => assertEqual(xml.pitchToCents('Z', 0, 4), null));

// ---------------------------------------------------------------------------
// parseMusicXml — hand-built minimal fixtures
// ---------------------------------------------------------------------------
function buildScaleXml(opts = {}) {
  const notes = opts.notes || [
    { step: 'C', alter: 0, octave: 4, dur: 1 },
    { step: 'D', alter: 0, octave: 4, dur: 1 },
    { step: 'E', alter: 0, octave: 4, dur: 1 },
    { step: 'F', alter: 0, octave: 4, dur: 1 },
    { step: 'G', alter: 0, octave: 4, dur: 1 },
    { step: 'A', alter: 0, octave: 4, dur: 1 },
    { step: 'B', alter: 0, octave: 4, dur: 1 },
    { step: 'C', alter: 0, octave: 5, dur: 1 },
  ];
  const div = opts.divisions || 1;
  const bpm = opts.bpm || 120;
  const noteXml = notes.map(n => `      <note>
        <pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch>
        <duration>${n.dur * div}</duration>
        <type>quarter</type>
      </note>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>${div}</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>
${noteXml}
    </measure>
  </part>
</score-partwise>`;
}

test('parseMusicXml: 4/4 C major scale → 8 on events with cents notes', () => {
  const r = xml.parseMusicXml(buildScaleXml({ divisions: 480 }));
  const ons = r.events.filter(e => e.type === 'on');
  assertEqual(ons.length, 8);
  assertEqual(ons.map(e => e.note), [6000, 6200, 6400, 6500, 6700, 6900, 7100, 7200]);
  assertEqual(r.ticksPerQuarter, 480);
});

test('parseMusicXml: emits matching off events at correct tick times', () => {
  const r = xml.parseMusicXml(buildScaleXml({ divisions: 480 }));
  const ons = r.events.filter(e => e.type === 'on').sort((a, b) => a.timeTicks - b.timeTicks);
  const offs = r.events.filter(e => e.type === 'off').sort((a, b) => a.timeTicks - b.timeTicks);
  assertEqual(ons.length, 8);
  assertEqual(offs.length, 8);
  for (let i = 0; i < ons.length; i++) {
    assertEqual(offs[i].note, ons[i].note);
    assertEqual(offs[i].timeTicks - ons[i].timeTicks, 480);
  }
});

test('parseMusicXml: tempo parsed from <sound tempo>', () => {
  const r = xml.parseMusicXml(buildScaleXml({ bpm: 96 }));
  for (const ev of r.events.filter(e => e.type === 'on')) {
    assertEqual(ev.tempoBPM, 96);
  }
});

test('parseMusicXml: parts metadata lists score-part names', () => {
  const r = xml.parseMusicXml(buildScaleXml());
  assertEqual(r.parts.length, 1);
  assertEqual(r.parts[0].id, 'P1');
  assertEqual(r.parts[0].name, 'Voice');
});

test('parseMusicXml: measures metadata lists measure numbers', () => {
  const r = xml.parseMusicXml(buildScaleXml());
  assertEqual(r.measures.length, 1);
  assertEqual(r.measures[0].number, '1');
  assertEqual(r.measures[0].startTick, 0);
});

test('parseMusicXml: rejects non-MusicXML text', () => {
  let threw = false;
  try { xml.parseMusicXml('<html><body>not music</body></html>'); }
  catch (e) { threw = true; }
  assert(threw);
});

test('parseMusicXml: rejects unsupported root', () => {
  let threw = false;
  try { xml.parseMusicXml('<?xml version="1.0"?><something-else/>'); }
  catch (e) { threw = true; }
  assert(threw);
});

// ---------------------------------------------------------------------------
// analyzeMusicXml — quarter-tone tests (the whole point of microtonal support)
// ---------------------------------------------------------------------------

test('analyzeMusicXml: 3 quarter-tone notes produce 3 distinct graph nodes', () => {
  // C4, C↑4, C#4 — all three are different pitches, all different nodes.
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><alter>0.5</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
  const r = xml.analyzeMusicXml(xmlText);
  const ids = r.graph.nodes.map(n => n.id).sort();
  assertEqual(ids, ['C#4', 'C4', 'C↑4']);
  assertEqual(r.stats.unique_note_count, 3);
  assertEqual(r.stats.transition_count, 2);   // C→C↑, C↑→C#
});

test('analyzeMusicXml: quarter-tone transition probabilities', () => {
  // C4 → C half-sharp 4 → C#4 → C#4 → C4 (repeated C#). Each transition
  // is unique because each source has only one outgoing. Verify all three
  // transitions exist with probability 1.0 (not that they sum to 1, but
  // that each individual one is 1.0 — the per-source normalization holds).
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><alter>0.5</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
  const r = xml.analyzeMusicXml(xmlText);
  assertEqual(r.graph.links.length, 3);
  for (const l of r.graph.links) {
    assertEqual(l.value, 1.0, `${l.source}→${l.target} should be 1.0`);
  }
});

test('analyzeMusicXml: end-to-end 2-bar phrase with sharps', () => {
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>96</per-minute></metronome></direction-type></direction>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>A</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>B</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note>
      <note><pitch><step>F</step><alter>1</alter><octave>5</octave></pitch><duration>2</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;
  const r = xml.analyzeMusicXml(xmlText);
  const seq = r.events.filter(e => e.type === 'on').map(e => M.centsToPitch(e.note));
  assertEqual(seq, ['G5', 'A5', 'B5', 'G5', 'G5', 'F#5']);
  const g5Loop = r.graph.links.find(l => l.source === 'G5' && l.target === 'G5');
  assert(g5Loop, 'expected G5→G5 self-loop');
});

// ---------------------------------------------------------------------------
// Stats display with quarter-tones
// ---------------------------------------------------------------------------
test('analyzeMusicXml: pitch range includes "semitones" word for fractional spans', () => {
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
      <note><pitch><step>C</step><alter>0.5</alter><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
  const r = xml.analyzeMusicXml(xmlText);
  // Range should show 0.5 semitones, not "0". centsToPitch renders "0.5"
  // because it's the JS toFixed default; that's fine.
  assert(/0\.5 semitones/.test(r.stats.pitch_range), `unexpected range: ${r.stats.pitch_range}`);
  // And the spelled names should appear (now in the short ↑ form).
  assert(r.stats.pitch_range.includes('C↑4'),
    `expected "C↑4" in pitch range, got: ${r.stats.pitch_range}`);
});

// ---------------------------------------------------------------------------
// Multi-tempo (P0-1): tempo changes between measures, in the middle of a
// measure, and at the start of a measure must all be reflected on the
// events that follow them.
// ---------------------------------------------------------------------------
function buildMultiTempoXml(opts) {
  // opts: { measure1Tempo, measure2Tempo, midMeasureTempo (optional) }
  const m1 = opts.measure1Tempo || 120;
  const m2 = opts.measure2Tempo || 120;
  const mid = opts.midMeasureTempo;
  const dir2 = m2 !== m1 ? `
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${m2}</per-minute></metronome></direction-type><sound tempo="${m2}"/></direction>` : '';
  const midBlock = mid != null ? `
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${mid}</per-minute></metronome></direction-type><sound tempo="${mid}"/></direction>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>480</duration><type>quarter</type></note>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>480</divisions></attributes>
      <direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${m1}</per-minute></metronome></direction-type><sound tempo="${m1}"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>480</duration><type>quarter</type></note>${midBlock}
    </measure>
    <measure number="2">${dir2}
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>480</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
}

test('parseMusicXml: tempo at start of measure 1 applies to measure 1 notes', () => {
  const r = xml.parseMusicXml(buildMultiTempoXml({ measure1Tempo: 90, measure2Tempo: 120 }));
  const c4on = r.events.find(e => e.type === 'on' && e.note === 6000);
  assertEqual(c4on.tempoBPM, 90);
});

test('parseMusicXml: tempo at start of measure 2 applies to measure 2 notes (not measure 1)', () => {
  const r = xml.parseMusicXml(buildMultiTempoXml({ measure1Tempo: 120, measure2Tempo: 60 }));
  const c4on = r.events.find(e => e.type === 'on' && e.note === 6000);
  const e4on = r.events.find(e => e.type === 'on' && e.note === 6400);
  assertEqual(c4on.tempoBPM, 120);
  assertEqual(e4on.tempoBPM, 60);
});

test('parseMusicXml: tempo change IN MIDDLE of a measure applies to subsequent notes only', () => {
  // C4 should be 120, D4 (after the mid-measure direction) should be 60.
  const r = xml.parseMusicXml(buildMultiTempoXml({ measure1Tempo: 120, midMeasureTempo: 60 }));
  const c4on = r.events.find(e => e.type === 'on' && e.note === 6000);
  const d4on = r.events.find(e => e.type === 'on' && e.note === 6200);
  assertEqual(c4on.tempoBPM, 120);
  assertEqual(d4on.tempoBPM, 60);
});

test('parseMusicXml: timing math across tempo change is correct', () => {
  // Measure 1: C4 at 120 BPM for 1 quarter = 0.5s.
  // Measure 2: tempo change to 60 BPM, E4 for 1 quarter = 1.0s.
  // Total wall-clock = 0.5 + 1.0 = 1.5s.
  const r = xml.parseMusicXml(buildMultiTempoXml({ measure1Tempo: 120, measure2Tempo: 60 }));
  const tickToSec = M.ticksToSecondsSegments(r.events, r.ticksPerQuarter);
  // E4 on is at tick 480 (end of measure 1 / start of measure 2)
  const e4on = r.events.find(e => e.type === 'on' && e.note === 6400);
  assert(Math.abs(tickToSec(e4on.timeTicks) - 0.5) < 1e-9,
    `E4 should be at 0.5s, got ${tickToSec(e4on.timeTicks)}`);
  // E4 off is at tick 960, which is 480 ticks into the 60-BPM segment = +1.0s
  const e4off = r.events.find(e => e.type === 'off' && e.note === 6400);
  assert(Math.abs(tickToSec(e4off.timeTicks) - 1.5) < 1e-9,
    `E4 off should be at 1.5s, got ${tickToSec(e4off.timeTicks)}`);
});

// ---------------------------------------------------------------------------
// buildSyntheticMusicXml — used to render sheet music for .mid files
// (which don't carry notation data).
// ---------------------------------------------------------------------------
test('buildSyntheticMusicXml: simple 4/4 sequence produces valid MusicXML', () => {
  // C4 quarter at tick 0, E4 quarter at tick 480, G4 quarter at tick 960,
  // C5 quarter at tick 1440, then a rest to fill the measure. 480 ticks/quarter.
  const events = [
    { timeTicks: 0,    type: 'on',  note: 6000, tempoBPM: 120 },
    { timeTicks: 480,  type: 'off', note: 6000, tempoBPM: 120 },
    { timeTicks: 480,  type: 'on',  note: 6400, tempoBPM: 120 },
    { timeTicks: 960,  type: 'off', note: 6400, tempoBPM: 120 },
    { timeTicks: 960,  type: 'on',  note: 6700, tempoBPM: 120 },
    { timeTicks: 1440, type: 'off', note: 6700, tempoBPM: 120 },
    { timeTicks: 1440, type: 'on',  note: 7200, tempoBPM: 120 },
    { timeTicks: 1920, type: 'off', note: 7200, tempoBPM: 120 },
  ];
  const xmlText = xml.buildSyntheticMusicXml(events, 480);
  // Must be valid MusicXML (re-parse it with the same parser).
  const r = xml.parseMusicXml(xmlText);
  assert(r.events.length === events.length,
    `re-parsed should have ${events.length} events, got ${r.events.length}`);
  // Pitches should be preserved through the cents → step/alter/octave
  // → cents round-trip (within 50 cents = quarter-tone resolution).
  const centsByIndex = [6000, 6400, 6700, 7200];
  const noteEvents = r.events.filter(e => e.type === 'on');
  for (let i = 0; i < centsByIndex.length; i++) {
    assert(Math.abs(noteEvents[i].note - centsByIndex[i]) <= 50,
      `note ${i}: expected ~${centsByIndex[i]} cents, got ${noteEvents[i].note}`);
  }
});

test('buildSyntheticMusicXml: real demo MIDI produces parseable output', () => {
  const fs = require('fs');
  const path = require('path');
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples', 'vp2-1all.mid')));
  const r = M.analyzeMidi(bytes);
  const xmlText = xml.buildSyntheticMusicXml(r.events, r.ticksPerQuarter);
  // Re-parse to ensure round-trip validity.
  const reparsed = xml.parseMusicXml(xmlText);
  assert(reparsed.events.length > 0, 're-parsed should have events');
  // vp2-1all.mid has 30 unique pitches spanning G#3 (cents 5600) to D6 (cents 8600).
  // Both should appear in the re-parsed events after the cents → step/alter/
  // octave → cents round-trip.
  const inCents = new Set(reparsed.events.filter(e => e.type === 'on').map(e => e.note));
  assert(inCents.has(5600), 'G#3 (5600¢) should appear');
  assert(inCents.has(8600), 'D6 (8600¢) should appear');
});

console.log('-----------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);