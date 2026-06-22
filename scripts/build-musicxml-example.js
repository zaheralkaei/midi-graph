// build-musicxml-example.js — generate a MusicXML version of the same Bach
// Minuet in G that build-example.js produces as MIDI. So we can verify the
// two parsers produce the same note sequence on the same input.
//
// Output: examples/minuet.musicxml
//
// Hand-written MusicXML; no library.

const fs = require('fs');
const path = require('path');

const PPQ = 1; // divisions per quarter — keep it simple
const BPM = 96;
// Use 6/4 time so each musical "phrase" (D D D G F# E) fits in one measure.
// The original is 3/4 (minuets are), but for this demo we double it to 6/4
// so the melodic groupings match measure boundaries exactly.
const BEATS_PER_MEASURE = 6;

// Same melody as build-example.js, expressed as pitch objects.
// [step, alter, octave, beats]
const melody = [
  // Bar 1: D5 D5 D5 G5 F#5 E5
  ['D', 0, 5, 1], ['D', 0, 5, 1], ['D', 0, 5, 1], ['G', 0, 5, 1], ['F', 1, 5, 1], ['E', 0, 5, 1],
  // Bar 2: F#5 F#5 E5 D5 D5 B4
  ['F', 1, 5, 1], ['F', 1, 5, 1], ['E', 0, 5, 1], ['D', 0, 5, 1], ['D', 0, 5, 1], ['B', 0, 4, 1],
  // Bar 3: C5 C5 B4 D5 E5 F#5
  ['C', 0, 5, 1], ['C', 0, 5, 1], ['B', 0, 4, 1], ['D', 0, 5, 1], ['E', 0, 5, 1], ['F', 1, 5, 1],
  // Bar 4: G5 A5 B5 G5
  ['G', 0, 5, 1], ['A', 0, 5, 1], ['B', 0, 5, 1], ['G', 0, 5, 1],
  // Bar 5
  ['D', 0, 5, 1], ['D', 0, 5, 1], ['D', 0, 5, 1], ['G', 0, 5, 1], ['F', 1, 5, 1], ['E', 0, 5, 1],
  // Bar 6
  ['F', 1, 5, 1], ['F', 1, 5, 1], ['E', 0, 5, 1], ['D', 0, 5, 1], ['D', 0, 5, 1], ['B', 0, 4, 1],
  // Bar 7
  ['C', 0, 5, 1], ['C', 0, 5, 1], ['B', 0, 4, 1], ['D', 0, 5, 1], ['E', 0, 5, 1], ['F', 1, 5, 1],
  // Bar 8: G5 whole
  ['G', 0, 5, 4],
];

function typeName(beats) {
  if (beats === 1) return 'quarter';
  if (beats === 2) return 'half';
  if (beats === 4) return 'whole';
  if (beats === 0.5) return 'eighth';
  return 'quarter';
}

function buildNote([step, alter, octave, beats]) {
  const alterTag = alter ? `<alter>${alter}</alter>` : '';
  return `        <note>
          <pitch><step>${step}</step>${alterTag}<octave>${octave}</octave></pitch>
          <duration>${beats * PPQ}</duration>
          <voice>1</voice>
          <type>${typeName(beats)}</type>
        </note>`;
}

function restNote(durationDivisions) {
  // Use a whole-measure rest if it fills the whole bar, else quarter.
  const beats = durationDivisions / PPQ;
  return `        <note>
          <rest/>
          <duration>${durationDivisions}</duration>
          <voice>1</voice>
          <type>${typeName(beats)}</type>
        </note>`;
}

// Group notes into measures by accumulating beats. Each measure should sum
// to exactly BEATS_PER_MEASURE beats.
const measures = [];
let currentMeasure = [];
let currentBeats = 0;
for (const n of melody) {
  const beats = n[3];
  if (currentBeats + beats > BEATS_PER_MEASURE) {
    while (currentBeats < BEATS_PER_MEASURE) {
      currentMeasure.push(['R', 0, 0, BEATS_PER_MEASURE - currentBeats]);
      currentBeats = BEATS_PER_MEASURE;
    }
    measures.push(currentMeasure);
    currentMeasure = [];
    currentBeats = 0;
  }
  currentMeasure.push(n);
  currentBeats += beats;
}
if (currentMeasure.length) {
  while (currentBeats < BEATS_PER_MEASURE) {
    currentMeasure.push(['R', 0, 0, BEATS_PER_MEASURE - currentBeats]);
    currentBeats = BEATS_PER_MEASURE;
  }
  measures.push(currentMeasure);
}

const measureXml = measures.map((m, idx) => {
  const number = idx + 1;
  let attributes = '';
  if (idx === 0) {
    attributes = `
          <attributes>
            <divisions>${PPQ}</divisions>
            <key><fifths>1</fifths></key>
            <time><beats>${BEATS_PER_MEASURE}</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          <direction placement="above">
            <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${BPM}</per-minute></metronome></direction-type>
            <sound tempo="${BPM}"/>
          </direction>`;
  }
  const notes = m.map(n => n[0] === 'R' ? restNote(n[3] * PPQ) : buildNote(n)).join('\n');
  return `      <measure number="${number}">${attributes}
${notes}
      </measure>`;
}).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>Minuet in G (BWV Anh. 114)</work-title></work>
  <identification>
    <creator type="composer">Johann Sebastian Bach (attr.)</creator>
    <encoding><software>midi-graph build script</software></encoding>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
${measureXml}
  </part>
</score-partwise>
`;

const outPath = path.join(__dirname, '..', 'examples', 'minuet.musicxml');
fs.writeFileSync(outPath, xml);
console.log(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);