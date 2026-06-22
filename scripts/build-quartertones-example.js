// build-quartertones-example.js — generate a small MusicXML file with
// quarter-tone alters so users can see microtonal rendering end-to-end.
//
// Uses an 8-note ascending phrase in C, going through each chromatic
// quarter-tone: C, C half-sharp, C#, C# half-sharp, D, D half-sharp, D#, D# half-sharp.
// 6/4 time, one quarter per note, so 4 measures (32 quarters total but only
// 8 notes + rests fill the bar).
//
// Output: examples/quartertones.musicxml

const fs = require('fs');
const path = require('path');

const PPQ = 1;
const BPM = 72;  // slow enough to hear the pitch differences clearly
const BEATS_PER_MEASURE = 4;

// step, alter, beats — the ascending quarter-tone ladder
const ladder = [
  ['C',  0,   1],
  ['C',  0.5, 1],
  ['C',  1,   1],
  ['C',  1.5, 1],
  ['D',  0,   1],
  ['D',  0.5, 1],
  ['D',  1,   1],
  ['D',  1.5, 1],
];

function buildNote([step, alter, beats]) {
  const alterTag = alter !== 0 ? `<alter>${alter}</alter>` : '';
  return `        <note>
          <pitch><step>${step}</step>${alterTag}<octave>4</octave></pitch>
          <duration>${beats * PPQ}</duration>
          <voice>1</voice>
          <type>quarter</type>
        </note>`;
}

function restNote(durationDivisions) {
  const beats = durationDivisions / PPQ;
  return `        <note>
          <rest/>
          <duration>${durationDivisions}</duration>
          <voice>1</voice>
          <type>quarter</type>
        </note>`;
}

// Two notes per measure (2 beats of notes + 2 beats of rest).
const measures = [];
for (let i = 0; i < ladder.length; i += 2) {
  const m = ladder.slice(i, i + 2);
  while (m.length < 2) m.push(null);  // pad with rest
  measures.push(m);
}

const measureXml = measures.map((m, idx) => {
  const number = idx + 1;
  let attrs = '';
  if (idx === 0) {
    attrs = `
          <attributes>
            <divisions>${PPQ}</divisions>
            <key><fifths>0</fifths></key>
            <time><beats>${BEATS_PER_MEASURE}</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef>
          </attributes>
          <direction placement="above">
            <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${BPM}</per-minute></metronome></direction-type>
            <sound tempo="${BPM}"/>
          </direction>`;
  }
  const notes = m.map(n => n === null ? restNote(2 * PPQ) : buildNote(n)).join('\n');
  return `      <measure number="${number}">${attrs}
${notes}
      </measure>`;
}).join('\n');

const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>Quarter-tone ladder</work-title></work>
  <identification>
    <creator type="composer">demo</creator>
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

const outPath = path.join(__dirname, '..', 'examples', 'quartertones.musicxml');
fs.writeFileSync(outPath, xml);
console.log(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);