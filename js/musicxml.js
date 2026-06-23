// musicxml.js — parse MusicXML into the same event shape as midi.js's parseMidi.
//
// Output: { events, ticksPerQuarter, parts: [{id, name, measureCount}], measures: [{ number, startTick }] }
//   events: [{ timeTicks, type: 'on'|'off', note, vel?, tempoBPM }, ...]
//   Same shape as MidiGraph.parseMidi so transitions/stats/playback/graph
//   don't care which format produced the data.
//
// Handles score-partwise (the overwhelmingly common format) and score-timewise
// (rare; flattened to partwise internally).
//
// Microtonal support is full — quarter-tones (alter = -1.5, -0.5, 0.5, 1.5)
// are preserved exactly as cents above C0. A C# half-sharp (alter=0.5, step=C)
// produces cents 6050 and stays distinct from C# (6100) and D (6200) through
// the entire pipeline.

(function () {
  const M = (typeof window !== 'undefined' ? window.MidiGraph : require('./midi.js'));

  // ---------------------------------------------------------------------------
  // XML parsing. Use DOMParser (built into browsers); provide a minimal stub
  // for node tests via @xmldom/xmldom if available, otherwise fall back to a
  // regex-based approach for the test fixtures.
  // ---------------------------------------------------------------------------
  function parseXmlString(xmlText) {
    if (typeof DOMParser !== 'undefined') {
      const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
      const err = doc.querySelector('parsererror');
      if (err) throw new Error('MusicXML parse error: ' + err.textContent.split('\n')[0]);
      return doc;
    }
    if (typeof M !== 'undefined' && M.__xmlDomParser) {
      const doc = M.__xmlDomParser.parseFromString(xmlText, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) {
        throw new Error('MusicXML parse error: ' + doc.getElementsByTagName('parsererror')[0].textContent);
      }
      return doc;
    }
    throw new Error('No XML parser available (need DOMParser, M.__xmlDomParser, or @xmldom/xmldom)');
  }

  // ---------------------------------------------------------------------------
  // Get the text content of the first matching child element, or ''.
  // ---------------------------------------------------------------------------
  function childText(parent, tagName) {
    const el = parent.getElementsByTagName(tagName)[0];
    return el ? el.textContent.trim() : '';
  }

  function childFloat(parent, tagName, fallback) {
    const el = parent.getElementsByTagName(tagName)[0];
    if (!el) return fallback;
    const v = parseFloat(el.textContent);
    return isNaN(v) ? fallback : v;
  }

  function hasChild(parent, tagName) {
    return parent.getElementsByTagName(tagName).length > 0;
  }

  // ---------------------------------------------------------------------------
  // step+alter+octave → cents. Delegates to the shared helper in midi.js so
  // quarter-tones (alter = -1.5, -0.5, 0.5, 1.5) are preserved exactly.
  // ---------------------------------------------------------------------------
  function pitchToCents(step, alter, octave) {
    return M.stepAlterOctaveToCents(step, alter, octave);
  }

  // ---------------------------------------------------------------------------
  // duration in divisions → ticks. We treat one division as one tick, matching
  // the MIDI PPQ convention closely enough for transition graphs.
  // ---------------------------------------------------------------------------
  function durationToTicks(divisions, durationDivisions) {
    return durationDivisions;
  }

  // ---------------------------------------------------------------------------
  // parseMusicXml(xmlText) → { events, ticksPerQuarter, parts, measures }
  // ---------------------------------------------------------------------------
  function parseMusicXml(xmlText) {
    const doc = parseXmlString(xmlText);
    const root = doc.documentElement;

    let partEls;
    let partList;
    if (root.tagName === 'score-partwise') {
      partList = root.getElementsByTagName('part-list')[0];
      partEls = Array.from(root.getElementsByTagName('part'));
    } else if (root.tagName === 'score-timewise') {
      // Timewise: <measure> contains multiple <part> children. Flatten to partwise.
      partList = root.getElementsByTagName('part-list')[0];
      const measureEls = Array.from(root.getElementsByTagName('measure'));
      const partIds = Array.from(partList ? partList.getElementsByTagName('score-part') : [])
        .map(sp => sp.getAttribute('id'));
      // For each part, gather its measures across all <measure> elements.
      const partMeasures = new Map();
      for (const m of measureEls) {
        const partsInMeasure = Array.from(m.getElementsByTagName('part'));
        for (const p of partsInMeasure) {
          const id = p.getAttribute('id');
          if (!partMeasures.has(id)) partMeasures.set(id, []);
          partMeasures.get(id).push(p);
        }
      }
      // Build a synthetic partwise document by re-wrapping each part's measures.
      partEls = [];
      for (const [id, measures] of partMeasures) {
        const partEl = doc.createElement('part');
        partEl.setAttribute('id', id);
        for (const m of measures) {
          // Move the <measure> element under our new <part>.
          partEl.appendChild(m.cloneNode(true));
        }
        partEls.push(partEl);
      }
    } else {
      throw new Error(`Unsupported MusicXML root: ${root.tagName} (expected score-partwise or score-timewise)`);
    }

    // Build part metadata.
    const parts = [];
    if (partList) {
      const scoreParts = Array.from(partList.getElementsByTagName('score-part'));
      for (const sp of scoreParts) {
        parts.push({
          id: sp.getAttribute('id'),
          name: childText(sp, 'part-name') || sp.getAttribute('id'),
        });
      }
    } else {
      // No part-list — synthesize ids.
      partEls.forEach((p, i) => {
        parts.push({ id: p.getAttribute('id') || `P${i + 1}`, name: `Part ${i + 1}` });
      });
    }

    // Default divisions per quarter (most files override in the first measure).
    let ticksPerQuarter = 480;
    const defaultTempoBPM = 120;

    const events = [];
    const measures = [];
    // Collect tempo-change points during parsing, then stamp each event in a
    // separate sweep. Format: sorted array of { tick, bpm } by tick ascending.
    // The first entry is the initial tempo at tick 0; subsequent entries
    // represent changes that take effect at that tick.
    const tempoChanges = [{ tick: 0, bpm: defaultTempoBPM }];

    // Walk each part.
    for (const partEl of partEls) {
      const measureEls = Array.from(partEl.getElementsByTagName('measure'));
      for (const measureEl of measureEls) {
        const measureNumber = measureEl.getAttribute('number') || '?';
        const measureStartTick = currentTickForPart(partEl, measureEl);

        // <attributes> may carry divisions and a tempo (sound or metronome).
        const attrEls = Array.from(measureEl.getElementsByTagName('attributes'));
        for (const a of attrEls) {
          const div = childFloat(a, 'divisions', null);
          if (div != null) ticksPerQuarter = div;
        }

        measures.push({ number: measureNumber, startTick: measureStartTick, partId: partEl.getAttribute('id') });

        // Walk <note> AND <direction> children in document order. This is the
        // fix for P0-3: directions can appear before, between, or after notes
        // within a measure, and the tempo they declare must apply to all notes
        // at or after their tick. We maintain a per-measure cursor that
        // <backup>/<forward> move; <direction> does NOT advance the cursor.
        let cursor = measureStartTick;
        const children = Array.from(measureEl.children);
        for (const child of children) {
          const tag = child.tagName;
          if (tag === 'note') {
            const noteEl = child;
            // <backup> moves the cursor backward; <forward> moves it forward.
            if (hasChild(noteEl, 'backup')) {
              const dur = childFloat(noteEl, 'duration', 0);
              cursor -= durationToTicks(ticksPerQuarter, dur);
              continue;
            }
            if (hasChild(noteEl, 'forward')) {
              const dur = childFloat(noteEl, 'duration', 0);
              cursor += durationToTicks(ticksPerQuarter, dur);
              continue;
            }

            const isChord = hasChild(noteEl, 'chord');
            const isRest = hasChild(noteEl, 'rest');
            const durDivisions = childFloat(noteEl, 'duration', ticksPerQuarter);
            const durTicks = durationToTicks(ticksPerQuarter, durDivisions);

            if (isRest) {
              cursor += durTicks;
              continue;
            }

            const pitchEl = noteEl.getElementsByTagName('pitch')[0];
            if (!pitchEl) {
              // Grace notes or other no-pitch — skip but advance cursor.
              cursor += durTicks;
              continue;
            }
            const step = childText(pitchEl, 'step');
            const alter = childFloat(pitchEl, 'alter', 0);
            const octave = parseInt(childText(pitchEl, 'octave'), 10);
            if (!step || isNaN(octave)) {
              cursor += durTicks;
              continue;
            }

            const cents = pitchToCents(step, alter, octave);
            if (cents == null) {
              cursor += durTicks;
              continue;
            }

            // Chord: simultaneous with the previous note. Emit at the same
            // start tick, same duration. The transition graph ignores
            // simultaneous notes by construction (transitions are sequential,
            // not parallel), so chord notes contribute zero to the graph
            // unless they're sequential.
            const startTick = isChord ? cursor - durTicks : cursor;
            const endTick = isChord ? startTick + durTicks : startTick + durTicks;

            // Crude velocity variation based on pitch — normalize against
            // cents (C4 = 6000), not MIDI. 100 cents = 1 semitone.
            const vel = Math.round(64 + 60 * (cents - 6000) / 6000);
            events.push({ timeTicks: startTick, type: 'on', note: cents, vel, tempoBPM: defaultTempoBPM });
            events.push({ timeTicks: endTick, type: 'off', note: cents, vel, tempoBPM: defaultTempoBPM });

            if (!isChord) cursor += durTicks;
          } else if (tag === 'direction') {
            // Extract tempo from <sound tempo="..."> or <metronome><per-minute>.
            const soundEl = child.getElementsByTagName('sound')[0];
            let dirBpm = null;
            if (soundEl && soundEl.getAttribute('tempo')) {
              const bpm = parseFloat(soundEl.getAttribute('tempo'));
              if (!isNaN(bpm)) dirBpm = bpm;
            }
            if (dirBpm == null) {
              const metroEl = child.getElementsByTagName('metronome')[0];
              if (metroEl) {
                const perMin = metroEl.getElementsByTagName('per-minute')[0];
                if (perMin) {
                  const bpm = parseFloat(perMin.textContent);
                  if (!isNaN(bpm)) dirBpm = bpm;
                }
              }
            }
            if (dirBpm != null) {
              // The direction takes effect at the current cursor (the same
              // tick as the next note or later within this measure). Using
              // cursor matches MusicXML semantics: a direction in the middle
              // of a measure applies from that point on.
              tempoChanges.push({ tick: cursor, bpm: dirBpm });
            }
          }
        }
      }
    }

    // Sort events by timeTicks so playback can interleave correctly.
    events.sort((a, b) => a.timeTicks - b.timeTicks);

    // Sort tempo changes by tick and dedupe consecutive duplicates. Multiple
    // parts may emit tempo changes at the same tick; collapse to one.
    tempoChanges.sort((a, b) => a.tick - b.tick);
    const dedupedTempos = [];
    for (const tc of tempoChanges) {
      const last = dedupedTempos[dedupedTempos.length - 1];
      if (!last || last.tick !== tc.tick) {
        dedupedTempos.push(tc);
      } else {
        // Same tick — keep the last declaration (later parts override earlier).
        last.bpm = tc.bpm;
      }
    }

    // Sweep: stamp each event with the tempo active at its tick. Walk events
    // in tick order and the tempo-change list in lockstep. For each event,
    // advance the tempoChange pointer until the next change is after the
    // event's tick.
    let tcIdx = 0;
    let activeBpm = dedupedTempos.length ? dedupedTempos[0].bpm : defaultTempoBPM;
    for (const ev of events) {
      while (tcIdx + 1 < dedupedTempos.length && dedupedTempos[tcIdx + 1].tick <= ev.timeTicks) {
        tcIdx++;
        activeBpm = dedupedTempos[tcIdx].bpm;
      }
      ev.tempoBPM = activeBpm;
    }

    return { events, ticksPerQuarter, parts, measures };
  }

  // Compute the absolute tick time at the start of a measure. We do this by
  // walking all measures of the part up to this one and summing their
  // <note><duration> + <forward> - <backup> durations. This is expensive but
  // robust to weird attribute placements.
  function currentTickForPart(partEl, targetMeasureEl) {
    const measures = Array.from(partEl.getElementsByTagName('measure'));
    let tick = 0;
    let ticksPerQuarterLocal = 480;
    for (const m of measures) {
      // Pick up divisions from this measure's attributes.
      const attrEls = Array.from(m.getElementsByTagName('attributes'));
      for (const a of attrEls) {
        const d = childFloat(a, 'divisions', null);
        if (d != null) ticksPerQuarterLocal = d;
      }
      if (m === targetMeasureEl) return tick;
      // Advance tick by the sum of all note durations + forwards - backups.
      let measureLen = 0;
      for (const n of Array.from(m.getElementsByTagName('note'))) {
        const dur = childFloat(n, 'duration', 0);
        if (hasChild(n, 'backup')) measureLen -= dur;
        else if (hasChild(n, 'forward')) measureLen += dur;
        else measureLen += dur;
      }
      tick += measureLen;
    }
    return tick;
  }

  // ---------------------------------------------------------------------------
  // Convenience: analyzeMusicXml(xmlText) — same shape as analyzeMidi.
  // ---------------------------------------------------------------------------
  function analyzeMusicXml(xmlText) {
    const { events, ticksPerQuarter, parts, measures } = parseMusicXml(xmlText);
    const notes = M.notesFromEvents(events);
    const graph = M.buildTransitionGraph(notes);
    const stats = M.computeStats(notes, graph);
    return { graph, stats, events, ticksPerQuarter, parts, measures };
  }

  // ---------------------------------------------------------------------------
// buildSyntheticMusicXml(events, ticksPerQuarter) → MusicXML 3.1 string
//
// Synthesizes a MusicXML score from a parsed MIDI event list so .mid files
// can also get a sheet-music render. Caveats:
//   - Notes use each note's actual duration (note_on → note_off pairs).
//     Unmatched note_ons (no following note_off) get a default quarter.
//   - One measure = 4 quarters (4/4 time, fixed).
//   - No dynamics, articulations, beaming, slurs, key signature, or
//     tempo markings — just pitches and approximate durations.
//   - Quarter-tones come through exactly because cents → step/alter/
//     octave uses QUARTER_TONE_NAMES.
//
// This is good enough to read the melody as sheet music; not good
// enough to use as the authoritative notation.
// ---------------------------------------------------------------------------
function buildSyntheticMusicXml(events, ticksPerQuarter) {
  // Pair note_on with note_off (same logic as playback.js).
  const pending = new Map();   // cents → tickOn
  const notes = [];             // [{ startTick, durTick, cents }]
  for (const ev of events) {
    if (ev.type === 'on') {
      pending.set(ev.note, ev.timeTicks);
    } else if (ev.type === 'off') {
      const tOn = pending.get(ev.note);
      if (tOn != null) {
        notes.push({
          startTick: tOn,
          durTick: Math.max(1, ev.timeTicks - tOn),
          cents: ev.note,
        });
        pending.delete(ev.note);
      }
    }
  }
  // Unmatched note_ons get a default quarter.
  const defaultDur = ticksPerQuarter || 480;
  for (const [cents, tOn] of pending) {
    notes.push({ startTick: tOn, durTick: defaultDur, cents });
  }
  // Sort by start time so the score reads top-to-bottom.
  notes.sort((a, b) => a.startTick - b.startTick);

  // Pick note durations as MusicXML divisions. Use the actual durTick
  // (MusicXML accepts any integer <duration>). The <type> tag is purely
  // for display and we set it to the closest standard duration that fits.
  const q = ticksPerQuarter || 480;
  const STD_DURATIONS = [
    { name: '16th',    div: q / 4 },
    { name: 'eighth',  div: q / 2 },
    { name: 'quarter', div: q },
    { name: 'half',    div: q * 2 },
    { name: 'whole',   div: q * 4 },
  ];
  function durNameFor(ticks) {
    const std = STD_DURATIONS.filter(d => d.div <= ticks).pop();
    return std ? std.name : '16th';
  }

  // Group notes by measure (4/4 time). MEASURE_TICKS = q * 4 = 1920.
  // If a note's duration exceeds the remaining ticks in its measure, we
  // push it to a "carryover" list that gets emitted at the START of the
  // next measure. This preserves pitch presence at the cost of putting
  // the carried note visually out-of-order (acceptable for a synthesized
  // score — better than silently dropping it).
  const MEASURE_TICKS = q * 4;
  const byMeasure = new Map();
  for (const n of notes) {
    const measIdx = Math.floor(n.startTick / MEASURE_TICKS);
    if (!byMeasure.has(measIdx)) byMeasure.set(measIdx, []);
    byMeasure.get(measIdx).push({
      cents: n.cents,
      divisions: Math.max(1, n.durTick),
      durName: durNameFor(n.durTick),
    });
  }
  if (byMeasure.size === 0) byMeasure.set(0, []);

  // Emit measures, processing carryover between them.
  const xml = [];
  xml.push('<?xml version="1.0" encoding="UTF-8"?>');
  // DOCTYPE + <defaults> + <identification> match the structure of a
  // MusicXML file exported from MuseScore / Sibelius / Dorico. OSMD
  // and other MusicXML consumers expect these to be present; a
  // minimal but valid <defaults> prevents "Cannot read properties of
  // undefined (reading 'toLowerCase')" errors that happen when OSMD
  // tries to read scaling/measure-layout attributes that don't exist.
  xml.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  xml.push('<score-partwise version="4.0">');
  xml.push('  <work><work-title>Synthesized</work-title></work>');
  xml.push('  <identification>');
  xml.push('    <encoding><software>midi-graph synth</software></encoding>');
  xml.push('  </identification>');
  xml.push('  <defaults>');
  xml.push('    <scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>');
  xml.push('    <page-layout><page-height>1700</page-height><page-width>1200</page-width></page-layout>');
  xml.push('    <staff-layout><staff-distance>80</staff-distance></staff-layout>');
  xml.push('  </defaults>');
  xml.push('  <part-list>');
  xml.push('    <score-part id="P1"><part-name>Synthesized</part-name></score-part>');
  xml.push('  </part-list>');
  xml.push('  <part id="P1">');

  const sortedMeas = Array.from(byMeasure.keys()).sort((a, b) => a - b);
  let carryover = [];
  for (const m of sortedMeas) {
    xml.push(`    <measure number="${m + 1}">`);
    const ns = byMeasure.get(m);
    let remaining = MEASURE_TICKS;
    let ni = 0;
    // Loop until both no more notes AND no more remaining space.
    while (ni < ns.length || carryover.length > 0 || remaining > 0) {
      const cur = carryover.length ? carryover.shift() : ns[ni++];
      if (!cur) {
        // No more notes; fill remaining with rests.
        const restDur = STD_DURATIONS.filter(d => d.div <= remaining).pop();
        if (!restDur) break;
        xml.push(`      <note>`);
        xml.push(`        <rest/>`);
        xml.push(`        <duration>${restDur.div}</duration>`);
        xml.push(`        <voice>1</voice>`);
        xml.push(`        <type>${restDur.name}</type>`);
        xml.push(`      </note>`);
        remaining -= restDur.div;
        continue;
      }
      if (cur.divisions <= remaining) {
        const sao = M.centsToStepAlterOctave(cur.cents);
        if (sao) {
          xml.push(`      <note>`);
          xml.push(`        <pitch>`);
          xml.push(`          <step>${sao.step}</step>`);
          if (sao.alter) xml.push(`          <alter>${sao.alter}</alter>`);
          xml.push(`          <octave>${sao.octave}</octave>`);
          xml.push(`        </pitch>`);
          xml.push(`        <duration>${cur.divisions}</duration>`);
          xml.push(`        <voice>1</voice>`);
          xml.push(`        <type>${cur.durName}</type>`);
          xml.push(`      </note>`);
        }
        remaining -= cur.divisions;
      } else {
        // Doesn't fit — carryover to next measure.
        carryover.push(cur);
        // If there's room for a rest, fill with the largest fitting rest.
        const restDur = STD_DURATIONS.filter(d => d.div <= remaining).pop();
        if (restDur) {
          xml.push(`      <note>`);
          xml.push(`        <rest/>`);
          xml.push(`        <duration>${restDur.div}</duration>`);
          xml.push(`        <voice>1</voice>`);
          xml.push(`        <type>${restDur.name}</type>`);
          xml.push(`      </note>`);
          remaining -= restDur.div;
        } else {
          break;  // no room for rest either; carryover will be processed next measure
        }
      }
    }
    xml.push(`    </measure>`);
  }

  xml.push('  </part>');
  xml.push('</score-partwise>');
  return xml.join('\n');
}

const api = { parseMusicXml, analyzeMusicXml, pitchToCents, buildSyntheticMusicXml };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MidiGraph = Object.assign(window.MidiGraph || {}, api);
  }
})();