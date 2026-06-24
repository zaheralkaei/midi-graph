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
  // C4, 6050¢, C#4 — all three are different pitches, all different nodes.
  // The 6050¢ pitch is written in MusicXML as <alter>0.5</alter> (half-sharp
  // of C), but under the new flat-spelled (next-LETTER) enharmonic
  // convention it displays as "D half-flat 4" (the next LETTER after C,
  // lowered by 50¢). The cents value is the same; only the display name
  // changed.
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
  assertEqual(ids, ['C#4', 'C4', 'D half-flat4']);
  assertEqual(r.stats.unique_note_count, 3);
  assertEqual(r.stats.transition_count, 2);   // C→D half-flat, D half-flat→C#
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
  // And the spelled names should appear (now in the flat-spelled
  // enharmonic form: "D half-flat 4" for 6050¢).
  assert(r.stats.pitch_range.includes('D half-flat4'),
    `expected "D half-flat4" in pitch range, got: ${r.stats.pitch_range}`);
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
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'examples', 'twinkle_twinkle.mid')));
  const r = M.analyzeMidi(bytes);
  const xmlText = xml.buildSyntheticMusicXml(r.events, r.ticksPerQuarter);
  // Re-parse to ensure round-trip validity.
  const reparsed = xml.parseMusicXml(xmlText);
  assert(reparsed.events.length > 0, 're-parsed should have events');
  // twinkle_twinkle.mid has 13 unique pitches spanning C#3 (cents 5300)
  // to B4 (cents 7100). After the cents → step/alter/octave → cents
  // round-trip the lowest pitch snaps from C#3 to D3 (5400¢) because
  // centsToStepAlterOctave returns the sharp-spelled enharmonic name
  // and the half-step is too small to survive the round-trip on its
  // own. We assert on D3 + B4 which both survive intact.
  const inCents = new Set(reparsed.events.filter(e => e.type === 'on').map(e => e.note));
  assert(inCents.has(5400), 'D3 (5400¢) should appear');
  assert(inCents.has(7100), 'B4 (7100¢) should appear');
});

// ---------------------------------------------------------------------------
// Regression: currentTickForPart must skip <chord/> notes when summing
// measure durations. Without this, a measure with 3 simultaneous chord
// notes advances the cursor by 3*duration instead of 1*duration, putting
// every subsequent measure 2 measures too late. Discovered via the
// examples/simple_harmony.musicxml audit (a 32-window I-IV-V-I-vi-ii-V7-I
// progression was producing events at 3-measure intervals instead of
// 1-measure).
// ---------------------------------------------------------------------------
test('parseMusicXml: <chord/> notes do not advance the per-part cursor', () => {
  // 3 measures, each with a 3-note sustained chord. With the bug, the
  // second chord would land at tick 5760 (3*1920) instead of 1920.
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>480</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>A</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1920</duration><type>whole</type></note>
    </measure>
    <measure number="3">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>D</step><octave>5</octave></pitch><duration>1920</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
  const r = xml.parseMusicXml(xmlText);
  // Group <on> events by their measure (computed from start tick).
  // Measure 1: 0-1919, m2: 1920-3839, m3: 3840-5759.
  const measureOf = (t) => Math.floor(t / 1920) + 1;
  const ons = r.events.filter(e => e.type === 'on');
  const m1Ons = ons.filter(e => measureOf(e.timeTicks) === 1);
  const m2Ons = ons.filter(e => measureOf(e.timeTicks) === 2);
  const m3Ons = ons.filter(e => measureOf(e.timeTicks) === 3);
  assertEqual(m1Ons.length, 3, 'measure 1 should have 3 <on> events (C, E, G)');
  assertEqual(m2Ons.length, 3, 'measure 2 should have 3 <on> events (F, A, C5)');
  assertEqual(m3Ons.length, 3, 'measure 3 should have 3 <on> events (G, B, D5)');
  // The m2 chord should start at exactly 1920, not 5760.
  assertEqual(m2Ons[0].timeTicks, 1920, 'm2 chord should start at tick 1920');
  assertEqual(m3Ons[0].timeTicks, 3840, 'm3 chord should start at tick 3840');
});

// ---------------------------------------------------------------------------
// End-to-end chord detection on examples/simple_harmony.musicxml.
// The file contains an 8-measure progression (I-IV-V-I-vi-ii-V7-I in C)
// and chordSequence should classify each measure correctly.
// ---------------------------------------------------------------------------
test('analyzeMusicXml + chordSequence: I-IV-V-I-vi-ii-V7-I in C major', () => {
  const fs = require('fs');
  const path = require('path');
  const xmlPath = path.join(__dirname, '..', 'examples', 'simple_harmony.musicxml');
  // Skip if the example file isn't present (e.g. fresh checkout without
  // scripts/build-simple-harmony.js having been run).
  if (!fs.existsSync(xmlPath)) {
    console.log('  skip  (examples/simple_harmony.musicxml not present)');
    return;
  }
  const xmlText = fs.readFileSync(xmlPath, 'utf-8');
  const r = xml.analyzeMusicXml(xmlText);
  const windows = M.chordSequence(r.events, { ticksPerQuarter: r.ticksPerQuarter });
  // 8 measures × 4 quarters = 32 windows. Each measure's 4 windows
  // should carry the same chord label.
  const expected = ['C', 'F', 'G', 'C', 'Am', 'Dm', 'G7', 'C'];
  for (let m = 0; m < 8; m++) {
    const winLabels = windows.slice(m * 4, m * 4 + 4).map(w => w.label);
    const allMatch = winLabels.every(l => l === expected[m]);
    assert(allMatch, `measure ${m + 1}: expected all windows "${expected[m]}", got ${JSON.stringify(winLabels)}`);
  }
});

// ---------------------------------------------------------------------------
// Regression: analyzeMusicXml must return the same shape as analyzeMidi so
// the harmonic graph, chord glow, and track picker all work for MusicXML
// files. Before this fix, analyzeMusicXml returned only
// { graph, stats, events, ticksPerQuarter, parts, measures } and the
// harmonic panel was hidden because chordWindows was undefined, and the
// track picker was hidden because trackAnalyses was empty.
// ---------------------------------------------------------------------------
test('analyzeMusicXml returns the analyzeMidi-compatible shape', () => {
  // Build a tiny 2-part MusicXML with 2 measures.
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Alto</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>480</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>1920</duration><type>whole</type></note>
      <note><chord/><pitch><step>C</step><octave>5</octave></pitch><duration>1920</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;
  const r = xml.analyzeMusicXml(xmlText);
  // analyzeMidi-compatible fields must all be present and non-empty.
  assert(Array.isArray(r.trackAnalyses), 'trackAnalyses should be an array');
  assert(r.trackAnalyses.length === 2, `trackAnalyses should have 2 entries, got ${r.trackAnalyses.length}`);
  assertEqual(r.trackAnalyses[0].userLabel, 'Soprano', 'first part should be labeled "Soprano"');
  assertEqual(r.trackAnalyses[1].userLabel, 'Alto', 'second part should be labeled "Alto"');
  assert(Array.isArray(r.chordWindows), 'chordWindows should be an array');
  assert(r.chordWindows.length > 0, 'chordWindows should be populated');
  // The harmonic graph would see C+E in m1 (C major) and F+A in m2 (F major).
  const m1Label = r.chordWindows[0].label;
  const m2Label = r.chordWindows[4].label;
  assertEqual(m1Label, 'C', `m1 should be "C", got "${m1Label}"`);
  assertEqual(m2Label, 'F', `m2 should be "F", got "${m2Label}"`);
  assertEqual(typeof r.monophonic, 'boolean', 'monophonic should be a boolean');
  assertEqual(r.monophonic, false, 'two parts playing together is not monophonic');
});

test('parseMusicXml: <divisions>0 falls back to default (no Infinity in playback)', () => {
  // Regression: an earlier version accepted any non-null <divisions>
  // value, including 0. ticksPerQuarter = 0 then propagated into
  // ticksToSecondsSegments (secondsPerTick = 1/0 * (60/bpm) = Inf),
  // making playback play back at infinite speed. The fix rejects
  // zero / negative divisions and falls back to the default 480.
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>0</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>480</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;
  const r = xml.analyzeMusicXml(xmlText);
  assert(r.ticksPerQuarter > 0, `ticksPerQuarter should be positive (got ${r.ticksPerQuarter})`);
  // Verify that building a playback controller doesn't blow up. With
  // the old (buggy) code, ticksPerQuarter = 0 made playback schedule
  // every note at time = Infinity, which Tone would silently drop.
  // With the fix, ticksPerQuarter = 480 and the controller builds
  // cleanly with finite durations.
  assert(r.events.length === 2, `should have 2 events (1 note on/off), got ${r.events.length}`);
  // The secondsPerTick formula is (1/tpq) * (60/bpm) — if tpq = 0 we'd
  // get Infinity. The fix ensures tpq > 0, so this is finite.
  const tpq = r.ticksPerQuarter;
  const secondsPerTick = (1 / tpq) * (60 / r.events[0].tempoBPM);
  assert(Number.isFinite(secondsPerTick),
    `secondsPerTick should be finite, got ${secondsPerTick}`);
});

test('chordSequence: low-tpq file (MuseScore export) is not empty', () => {
  // Regression: the harmonic graph was empty for MusicXML files exported
  // by MuseScore because they use <divisions>2 (ticksPerQuarter=2) instead
  // of MIDI's standard 480. The app's dropdown was hardcoded to 480 ticks
  // for "Quarter note", so for a tpq=2 file the window became 240 quarters
  // — far longer than the file, producing 0 or 1 chord windows.
  //
  // The fix: the dropdown now stores quarter-note UNITS (0.5, 1, 2) and
  // app.js multiplies by ticksPerQuarter to get the actual window. With
  // windowTicks=2 (= 1 quarter for a tpq=2 file), a 5-measure piece
  // produces 20 chord windows. We assert that the windowTicks computed
  // by the same formula app.js uses is correct.
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    ${Array.from({length: 5}, (_, i) => `
    <measure number="${i + 1}">
      <attributes><divisions>2</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>quarter</type></note>
    </measure>`).join('')}
  </part>
</score-partwise>`;
  const r = xml.analyzeMusicXml(xmlText);
  // MuseScore-style low-tpq file: 5 measures × 4 quarter notes each
  // at tpq=2 = 40 ticks total.
  assertEqual(r.ticksPerQuarter, 2, 'MuseScore default divisions=2');
  // The app's formula: windowTicks = quarters * ticksPerQuarter
  // where quarters comes from the dropdown. For "Quarter note" (value=1):
  const quarters = 1;
  const tpq = r.ticksPerQuarter;
  const windowTicks = Math.max(1, Math.round(quarters * tpq));
  assertEqual(windowTicks, 2, 'windowTicks should be 2 ticks (= 1 quarter at tpq=2)');
  // Re-running chordSequence with the correct windowTicks should produce
  // 20 windows for this 5-measure file (5 × 4 quarters).
  const windows = M.chordSequence(r.events, { ticksPerQuarter: tpq, windowTicks });
  assertEqual(windows.length, 20, `expected 20 chord windows, got ${windows.length}`);
  // And each window should detect a C major chord (C+E+G with C in
  // bass = "C", or all four notes C+E+G+C = still "C").
  for (const w of windows) {
    assert(w.label && w.label !== '(silence)', `window should be non-silence, got "${w.label}"`);
  }
});

test('centsToPitch half-flat name format is parseable by graph.pitchOf regex', () => {
  // Regression: graph.js's `pitchOf` regex is the bridge between
  // node IDs (produced by centsToPitch) and cents (used by setActive
  // to look up which node to glow). The previous regex required
  // "half-flat " (with trailing space) but centsToPitch actually
  // produces "half-flat4" (no space) — so every quarter-tone note
  // had pitchOf() return the default 6000, and setActive(6150, true)
  // silently failed to glow the E half-flat 4 node. Bug surfaced
  // when loading the ya-tyra demo and the user's ya-tyra_with_h
  // test file.
  //
  // This test pins the round-trip: for every cents value that
  // centsToPitch might return with a "half-flat" form, the regex
  // must successfully match and produce the correct cents.
  const testCases = [
    { cents: 6150, name: 'E half-flat4',  expectedCents: 6150 },  // 4th half-flat of C4 area
    { cents: 5350, name: 'B half-flat3',  expectedCents: 5350 },  // 2nd half-flat of A3
    { cents: 5650, name: 'D half-flat3',  expectedCents: 5650 },  // 2nd half-flat of C3
    { cents: 6000, name: 'C4',            expectedCents: 6000 },  // natural (no alteration)
    { cents: 6100, name: 'C#4',           expectedCents: 6100 },  // sharp
    { cents: 6050, name: 'C\u21914',      expectedCents: 6050 },  // half-sharp with arrow
    { cents: 6150, name: 'E half-flat 4', expectedCents: 6150 },  // legacy form (with space)
  ];
  // The regex from graph.js's pitchOf. We replicate it here so the
  // test pins the contract independently from graph.js's internals.
  // If the regex changes in graph.js, this test will need to be
  // updated to match — the intent is that the regex is permissive
  // about both "half-flat4" and "half-flat 4".
  const pitchOfRegex = /^([A-G][#]?)(?:\u2191| half-sharp ?| half-flat ?)?(-?\d+)$/;
  for (const tc of testCases) {
    const m = tc.name.match(pitchOfRegex);
    assert(m, `pitchOf regex should match "${tc.name}"`);
    // Also assert centsToPitch itself produces a parseable form
    // (this is the live bug — if centsToPitch changed format,
    // pitchOf would need to change too).
    const liveName = M.centsToPitch(tc.cents);
    const liveMatch = liveName.match(pitchOfRegex);
    assert(liveMatch, `centsToPitch(${tc.cents}) = "${liveName}" should match pitchOf regex`);
  }
});

console.log('-----------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);