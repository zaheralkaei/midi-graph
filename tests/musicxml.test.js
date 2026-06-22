// tests/musicxml.test.js — smoke tests for js/musicxml.js
//
// Wires up @xmldom/xmldom's DOMParser into the musicxml module so the same
// source code runs in both node and browser.

const { DOMParser } = require('@xmldom/xmldom');
const M = require('../js/midi.js');
const xml = require('../js/musicxml.js');

// Inject the xmldom DOMParser so musicxml.js can use it in node.
M.__xmlDomParser = { parseFromString: (text, type) => new DOMParser().parseFromString(text, type) };

let pass = 0, fail = 0;
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
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || ''} expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// pitchToMidi — pure function, easiest to test first.
// ---------------------------------------------------------------------------
console.log('musicxml.js tests');
console.log('-----------------');

test('pitchToMidi: C4 → 60', () => {
  assertEqual(xml.pitchToMidi('C', 0, 4), 60);
});
test('pitchToMidi: A4 → 69', () => {
  assertEqual(xml.pitchToMidi('A', 0, 4), 69);
});
test('pitchToMidi: F#4 (alter=1) → 66', () => {
  assertEqual(xml.pitchToMidi('F', 1, 4), 66);
});
test('pitchToMidi: Bb4 (alter=-1) → 70', () => {
  assertEqual(xml.pitchToMidi('B', -1, 4), 70);
});
test('pitchToMidi: microtone alter=0.5 rounds up to nearest semitone', () => {
  // C quarter-sharp = 60.5 → rounds to 61 (C#)
  assertEqual(xml.pitchToMidi('C', 0.5, 4), 61);
});
test('pitchToMidi: microtone alter=-0.5 rounds to nearest semitone', () => {
  // C quarter-flat = 59.5 → rounds to 60 (C)
  assertEqual(xml.pitchToMidi('C', -0.5, 4), 60);
});
test('pitchToMidi: invalid step returns null', () => {
  assertEqual(xml.pitchToMidi('Z', 0, 4), null);
});

// ---------------------------------------------------------------------------
// parseMusicXml — hand-built minimal MusicXML fixtures.
// ---------------------------------------------------------------------------

// Build a minimal 1-measure, 4-quarter C major scale in MusicXML.
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
  const div = opts.divisions || 1;  // 1 division per quarter
  const bpm = opts.bpm || 120;
  const noteXml = notes.map(n => `      <note>
        <pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch>
        <duration>${n.dur * div}</duration>
        <type>quarter</type>
      </note>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>${div}</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type>
        <sound tempo="${bpm}"/>
      </direction>
${noteXml}
    </measure>
  </part>
</score-partwise>`;
}

test('parseMusicXml: 4/4 C major scale produces 8 note-on events', () => {
  const r = xml.parseMusicXml(buildScaleXml({ divisions: 480 }));
  const ons = r.events.filter(e => e.type === 'on');
  assertEqual(ons.length, 8);
  assertEqual(ons.map(e => e.note), [60, 62, 64, 65, 67, 69, 71, 72]);
  assertEqual(r.ticksPerQuarter, 480);
});

test('parseMusicXml: emits matching off events at correct tick times', () => {
  const r = xml.parseMusicXml(buildScaleXml({ divisions: 480 }));
  // The scale is 8 quarter notes starting at tick 0. Each note off should be
  // exactly 480 ticks after its note on.
  const ons = r.events.filter(e => e.type === 'on').sort((a, b) => a.timeTicks - b.timeTicks);
  const offs = r.events.filter(e => e.type === 'off').sort((a, b) => a.timeTicks - b.timeTicks);
  assertEqual(ons.length, 8);
  assertEqual(offs.length, 8);
  for (let i = 0; i < ons.length; i++) {
    assertEqual(offs[i].note, ons[i].note);
    assertEqual(offs[i].timeTicks - ons[i].timeTicks, 480);
  }
});

test('parseMusicXml: tempo is parsed from <sound tempo>', () => {
  const r = xml.parseMusicXml(buildScaleXml({ bpm: 96 }));
  const ons = r.events.filter(e => e.type === 'on');
  for (const ev of ons) {
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
  try {
    xml.parseMusicXml('<html><body>not music</body></html>');
  } catch (e) {
    threw = true;
    assert(e.message.includes('MusicXML') || e.message.includes('parse error'),
      `expected parse error, got: ${e.message}`);
  }
  assert(threw, 'should have thrown');
});

test('parseMusicXml: rejects unsupported root element', () => {
  let threw = false;
  try {
    xml.parseMusicXml('<?xml version="1.0"?><something-else/>');
  } catch (e) {
    threw = true;
    assert(e.message.includes('Unsupported'), `expected Unsupported, got: ${e.message}`);
  }
  assert(threw, 'should have thrown');
});

// ---------------------------------------------------------------------------
// analyzeMusicXml — convenience wrapper, mirrors analyzeMidi's output shape.
// ---------------------------------------------------------------------------
test('analyzeMusicXml: returns graph + stats compatible with analyzeMidi', () => {
  const r = xml.analyzeMusicXml(buildScaleXml({ divisions: 480 }));
  assert('graph' in r && 'stats' in r && 'events' in r);
  assertEqual(r.stats.note_count, 8);
  assertEqual(r.stats.unique_note_count, 8);
  // 7 transitions between 8 notes (sequential, no self-loops in a scale)
  assertEqual(r.stats.transition_count, 7);
  assertEqual(r.stats.self_loop_count, 0);
});

// ---------------------------------------------------------------------------
// End-to-end: build a Bach-minuet-shaped MusicXML and verify it parses into
// the same note sequence as the .mid version.
// ---------------------------------------------------------------------------
test('analyzeMusicXml: end-to-end on a 2-bar phrase with sharps', () => {
  // Bar 1: G5 quarter, A5 quarter, B5 quarter, G5 quarter (D-major-ish)
  // Bar 2: G5 half, F#5 half
  const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
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
  // Notes in order: G5, A5, B5, G5, G5, F#5
  const seq = r.events.filter(e => e.type === 'on').map(e => M.midiToPitch(e.note));
  assertEqual(seq, ['G5', 'A5', 'B5', 'G5', 'G5', 'F#5']);
  // G5→G5 self-loop from the repeated note
  const g5Loop = r.graph.links.find(l => l.source === 'G5' && l.target === 'G5');
  assert(g5Loop, 'expected G5→G5 self-loop');
});

console.log('-----------------');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);