// Build a simple_harmony.mxl (a .mxl file is a ZIP containing the
// MusicXML document + a META-INF/container.xml).
//
// We use the same fflate-based writer that the app uses for the
// opposite direction (reading .mxl via extractMxl). For simplicity
// here we just build a .musicxml file (not zipped) — the app's
// content sniffer routes ".mxl" through fflate, but a plain
// .musicxml text is detected as MusicXML and goes through the same
// parser. We'll write the file as examples/simple_harmony.musicxml
// and let the user load it via the file input.

const fs = require('fs');
const path = require('path');

// Quarter notes at 480-tpq. One whole note = 1920 ticks.
//
// 8 windows, one chord per window, each window = 1 quarter note = 480 ticks.
// Total length: 8 * 480 = 3840 ticks = 2 whole notes (8 quarters = 2 measures
// of 4/4).
//
// Progression (chord roots in C major):
//   m1: C major (C4 E4 G4)
//   m2: F major (F4 A4 C5)
//   m3: G major (G4 B4 D5)
//   m4: C major (C4 E4 G4)
//   m5: A minor (A3 C4 E4)
//   m6: D minor (D4 F4 A4)
//   m7: G7      (G3 B3 D4 F4)
//   m8: C major (C4 E4 G4)

const notes = [
  // Window 1: C major — C4 (MIDI 60), E4 (64), G4 (67)
  { step: 'C', octave: 4, alter: 0, duration: 480 },
  { step: 'E', octave: 4, alter: 0, duration: 480 },
  { step: 'G', octave: 4, alter: 0, duration: 480 },
  // Window 2: F major — F4 (65), A4 (69), C5 (72)
  { step: 'F', octave: 4, alter: 0, duration: 480 },
  { step: 'A', octave: 4, alter: 0, duration: 480 },
  { step: 'C', octave: 5, alter: 0, duration: 480 },
  // Window 3: G major — G4 (67), B4 (71), D5 (74)
  { step: 'G', octave: 4, alter: 0, duration: 480 },
  { step: 'B', octave: 4, alter: 0, duration: 480 },
  { step: 'D', octave: 5, alter: 0, duration: 480 },
  // Window 4: C major — C4 E4 G4
  { step: 'C', octave: 4, alter: 0, duration: 480 },
  { step: 'E', octave: 4, alter: 0, duration: 480 },
  { step: 'G', octave: 4, alter: 0, duration: 480 },
  // Window 5: A minor — A3 C4 E4
  { step: 'A', octave: 3, alter: 0, duration: 480 },
  { step: 'C', octave: 4, alter: 0, duration: 480 },
  { step: 'E', octave: 4, alter: 0, duration: 480 },
  // Window 6: D minor — D4 F4 A4
  { step: 'D', octave: 4, alter: 0, duration: 480 },
  { step: 'F', octave: 4, alter: 0, duration: 480 },
  { step: 'A', octave: 4, alter: 0, duration: 480 },
  // Window 7: G7 — G3 B3 D4 F4
  { step: 'G', octave: 3, alter: 0, duration: 480 },
  { step: 'B', octave: 3, alter: 0, duration: 480 },
  { step: 'D', octave: 4, alter: 0, duration: 480 },
  { step: 'F', octave: 4, alter: 0, duration: 480 },
  // Window 8: C major — C4 E4 G4 (resolution)
  { step: 'C', octave: 4, alter: 0, duration: 480 },
  { step: 'E', octave: 4, alter: 0, duration: 480 },
  { step: 'G', octave: 4, alter: 0, duration: 480 },
];

function noteXml(n) {
  const alterXml = n.alter ? `<alter>${n.alter}</alter>` : '';
  return `<note><pitch><step>${n.step}</step>${alterXml}<octave>${n.octave}</octave></pitch><duration>${n.duration}</duration><type>quarter</type></note>`;
}

// 8 measures, 3 notes per measure for first 6, 4 notes for measure 7, 3 for 8.
// One note per beat — that means each note rings for 1 quarter, so the chord
// at each beat is a single note. To make a CHORD (multiple notes sounding
// simultaneously), we need to put 3 notes in the SAME beat (duration 480 with
// the same start time). MusicXML groups notes into the same beat by position
// — but for our purpose, putting 3 notes back-to-back in the same measure
// with the same duration is what matters: the chordSequence reads the
// currently-sounding pitches across time.
//
// Actually: in our chordSequence, the windows are fixed-size bins. As long
// as the 3 notes of a chord are ALL sounding during the bin's time range,
// the chord is detected. Since we put 3 quarter notes back-to-back in the
// same measure, the 3rd note of the previous chord is still sounding when
// the 1st note of the next chord starts — the chord window sees 2-3
// overlapping pitches.
//
// To get CLEAN chords (one window = one triad, no overlap), we need to use
// longer note durations. Let me redo this with HALF notes (960 ticks) and
// 1-note-per-half, so the chord is one sustained triad for 4 beats.
//
// Actually simpler: use 1 chord per WHOLE measure (4 quarters = 1920 ticks)
// with 3 notes, each of duration 1920. All 3 notes sound for the whole
// measure. The window is 480 ticks, so each measure has 4 windows all
// containing the same 3 pitches. That's fine for testing — the chord
// detection should give the same label for all 4 windows of a measure.

const chords = [
  ['C4', 'E4', 'G4'],     // C major
  ['F4', 'A4', 'C5'],     // F major
  ['G4', 'B4', 'D5'],     // G major
  ['C4', 'E4', 'G4'],     // C major
  ['A3', 'C4', 'E4'],     // A minor
  ['D4', 'F4', 'A4'],     // D minor
  ['G3', 'B3', 'D4', 'F4'], // G7
  ['C4', 'E4', 'G4'],     // C major (resolution)
];

function noteOf(pitch) {
  const m = pitch.match(/^([A-G])(#|b)?(-?\d+)$/);
  const step = m[1];
  const alter = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = parseInt(m[3], 10);
  return { step, octave, alter };
}

const measureXml = chords.map((chord, i) => {
  const chordNotes = chord.map(noteOf);
  // In MusicXML, multiple notes at the same time must be marked with
  // <chord/> on all-but-the-first note. Without it the parser treats
  // them as sequential — each at its own cursor position — and the
  // chord detection sees only one pitch per window.
  const notesXml = chordNotes.map((n, idx) => {
    const alterXml = n.alter ? `<alter>${n.alter}</alter>` : '';
    const chordXml = idx > 0 ? '<chord/>' : '';
    // Whole note = 4 quarters = 4 * 480 = 1920 ticks
    return `<note>${chordXml}<pitch><step>${n.step}</step>${alterXml}<octave>${n.octave}</octave></pitch><duration>1920</duration><type>whole</type></note>`;
  }).join('\n      ');
  // The FIRST measure has the attributes block, the rest just have notes.
  const attributes = i === 0 ? `<attributes>
        <divisions>480</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>` : '';
  return `  <measure number="${i + 1}">
      ${attributes}
      ${notesXml}
  </measure>`;
}).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
    </score-part>
  </part-list>
  <part id="P1">
${measureXml}
  </part>
</score-partwise>
`;

const outPath = path.join(__dirname, '..', 'examples', 'simple_harmony.musicxml');
fs.writeFileSync(outPath, xml, 'utf-8');
console.log('Wrote', outPath, '(' + xml.length + ' bytes)');
console.log('Progression (expected labels):');
const expected = ['C major', 'F major', 'G major', 'C major', 'A minor', 'D minor', 'G7', 'C major'];
expected.forEach((e, i) => console.log('  m' + (i+1) + ': ' + e));
