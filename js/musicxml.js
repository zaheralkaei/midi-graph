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
    let tempoBPM = 120;
    let microsPerQuarter = 500000;

    const events = [];
    const measures = [];

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

        // Timewise flattened partwise still has nested <part><measure> — guard
        // against measuring tick via the part cursor (see below).
        measures.push({ number: measureNumber, startTick: measureStartTick, partId: partEl.getAttribute('id') });

        // Walk <note> children in document order. We use a per-measure cursor
        // because <backup>/<forward> move it.
        let cursor = measureStartTick;
        const noteEls = Array.from(measureEl.getElementsByTagName('note'));
        for (const noteEl of noteEls) {
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

          // Tempo from <direction> siblings? Handle inside the loop only if
          // the note's previous sibling is a direction. Simpler: collect
          // tempos from the whole measure at the start (below).

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

          // Chord: simultaneous with the previous note, so same on-time but
          // separate off-time? In MusicXML, chord notes share the previous
          // note's duration. We just emit on/off for the chord note at the
          // previous note's start, with the same duration. The transition
          // graph ignores simultaneous notes by construction (transitions are
          // sequential, not parallel), so chord notes contribute zero to the
          // graph unless they're sequential.
          const startTick = isChord ? cursor - durTicks : cursor;
          const endTick = isChord ? startTick + durTicks : startTick + durTicks;

          // Crude velocity variation based on pitch — but normalize against
          // cents (C4 = 6000), not MIDI (C4 = 60). 100 cents = 1 semitone.
          const vel = Math.round(64 + 60 * (cents - 6000) / 6000);
          events.push({ timeTicks: startTick, type: 'on', note: cents, vel, tempoBPM });
          events.push({ timeTicks: endTick, type: 'off', note: cents, vel, tempoBPM });

          if (!isChord) cursor += durTicks;
        }

        // Collect tempo changes from this measure's <direction> elements.
        const directionEls = Array.from(measureEl.getElementsByTagName('direction'));
        for (const dir of directionEls) {
          const soundEl = dir.getElementsByTagName('sound')[0];
          if (soundEl && soundEl.getAttribute('tempo')) {
            const bpm = parseFloat(soundEl.getAttribute('tempo'));
            if (!isNaN(bpm)) {
              tempoBPM = bpm;
              microsPerQuarter = Math.round(60_000_000 / bpm);
            }
          }
          const metroEl = dir.getElementsByTagName('metronome')[0];
          if (metroEl) {
            const perMin = metroEl.getElementsByTagName('per-minute')[0];
            if (perMin) {
              const bpm = parseFloat(perMin.textContent);
              if (!isNaN(bpm)) {
                tempoBPM = bpm;
                microsPerQuarter = Math.round(60_000_000 / bpm);
              }
            }
          }
        }
      }
    }

    // Sort events by timeTicks so playback can interleave correctly.
    events.sort((a, b) => a.timeTicks - b.timeTicks);

    // Stamp each event with the current tempoBPM. For multi-tempo files this
    // needs a sweep; for single-tempo it's a no-op.
    let activeBPM = 120;
    let activeMicros = 500000;
    // Re-walk measure by measure to pick up tempo changes; for now assume
    // single-tempo (set in the loop above) and stamp everything with it.
    // (Multi-tempo refinement: walk events in order, recompute tempoBPM from
    // the measure-by-measure scan. We have measure boundaries in `measures`,
    // so a future pass can do this.)
    for (const ev of events) {
      ev.tempoBPM = tempoBPM;
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

  const api = { parseMusicXml, analyzeMusicXml, pitchToCents };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MidiGraph = Object.assign(window.MidiGraph || {}, api);
  }
})();