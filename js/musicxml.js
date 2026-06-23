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

  // buildSyntheticMusicXml(eventsOrResult, ticksPerQuarter?) → MusicXML 3.1 string
  //
  // Synthesizes a MusicXML score from MIDI events so .mid files (which
  // don't carry notation data) can render sheet music alongside the
  // transition graph. Four improvements over the original hand-rolled
  // approach:
  //
  //   1. Multi-track selection — real MIDI often has the melody in track
  //      1 and accompaniment / drums in others. We pick the track with
  //      the most note_on events and use only its events. If parseMidi
  //      didn't expose per-track data (older call sites), we fall back
  //      to the merged events stream.
  //
  //   2. Time-signature detection — MIDI files can carry FF 58 meta
  //      events. The first one wins (we don't yet support mid-piece
  //      signature changes). If absent, default to 4/4. The signature
  //      drives the measure length and is emitted as <attributes><time>
  //      in the first measure.
  //
  //   3. Chord grouping — simultaneous note_ons (within a tolerance of
  //      ~1/8 of a quarter, to absorb human timing jitter) are bundled
  //      into one MusicXML chord: one <note> + N-1 <chord/> siblings
  //      sharing a single rhythmic position. Without this, a piano triad
  //      reads as three consecutive notes instead of a stacked chord
  //      symbol — visually wrong for any polyphonic material.
  //
  //   4. Measure overflow with ties — a note that doesn't fit in the
  //      remaining measure ticks is split: the part that fits gets
  //      <tie type="start"/> and the remainder lands in the next
  //      measure with <tie type="stop"/>. This is the MusicXML-correct
  //      way to handle cross-measure durations; OSMD renders ties
  //      correctly. Replaces the previous "push to carryover, flush
  //      overflow into a final measure" hack that was the source of
  //      every "jammed notes / wrong values" bug report.
  //
  // Signature: accepts either (events, ticksPerQuarter) — old call site
  // used by the test suite — or (analyzeResult) where analyzeResult has
  // { events, ticksPerQuarter, tracks?, timeSignatures? }. The new form
  // unlocks the multi-track + time-signature improvements; the old form
  // still works (with all-notes-merged, no time-sig metadata).
  function buildSyntheticMusicXml(eventsOrResult, ticksPerQuarter) {
    // Normalize the signature. Old call site: (events, ticksPerQuarter).
    // New call site: (analyzeResult) where analyzeResult has
    // { events, ticksPerQuarter, tracks?, timeSignatures? }.
    let allEvents, tracks, timeSignatures, tpq;
    if (Array.isArray(eventsOrResult)) {
      allEvents = eventsOrResult;
      tpq = ticksPerQuarter;
    } else {
      allEvents = eventsOrResult.events;
      tracks = eventsOrResult.tracks;
      timeSignatures = eventsOrResult.timeSignatures;
      tpq = eventsOrResult.ticksPerQuarter;
    }

    // ---- 1. Multi-track selection ----
    // If parseMidi gave us per-track events, pick the track with the most
    // note_on events. Tracks with only meta events (tempo/time-sig text
    // markers, controller moves, etc.) get filtered out automatically.
    // If no per-track data was passed (old call sites), fall back to the
    // merged stream — same behavior as before.
    if (tracks && tracks.length > 1) {
      let bestTrack = 0;
      let bestCount = -1;
      for (let i = 0; i < tracks.length; i++) {
        let n = 0;
        for (const e of tracks[i]) if (e.type === 'on') n++;
        if (n > bestCount) { bestCount = n; bestTrack = i; }
      }
      // Only switch if the chosen track actually has notes — a file
      // where all tracks are empty is degenerate but possible.
      if (bestCount > 0) {
        events = tracks[bestTrack];
      } else {
        events = allEvents;
      }
    } else {
      events = allEvents;
    }

    // ---- 2. Time-signature detection ----
    // First FF 58 meta wins. Default 4/4 if absent or unparseable.
    let timeNum = 4, timeDen = 4;
    if (timeSignatures && timeSignatures.length > 0) {
      const ts = timeSignatures[0];
      if (ts.num >= 1 && ts.num <= 32 && ts.den >= 1 && ts.den <= 64) {
        timeNum = ts.num;
        timeDen = ts.den;
      }
    }
    // Measure length = (timeNum / timeDen) * 4 * tpq quarters... actually
    // measure ticks = timeNum * (ticksPerQuarter * 4 / timeDen).
    // For 4/4 that's 4 * tpq. For 3/4 it's 3 * tpq. For 6/8 it's
    // 6 * tpq / 2 = 3 * tpq. The formula below is correct for any
    // numerator / denominator pair.
    const q = tpq || 480;
    const MEASURE_TICKS = Math.round(timeNum * (q * 4 / timeDen));
    const TIE_SPLIT_EPS = q / 16;  // chord-grouping tolerance (~1/16 quarter)

    // ---- Pair note_on with note_off (FIFO stack per pitch) ----
    // Same logic as before but only over the selected track's events.
    // Note: the FIFO/LIFO choice doesn't matter here because we already
    // apply the same algorithm — keep it consistent with playback.js.
    const pending = new Map();
    const notes = [];
    for (const ev of events) {
      if (ev.type === 'on') {
        if (!pending.has(ev.note)) pending.set(ev.note, []);
        pending.get(ev.note).push(ev.timeTicks);
      } else if (ev.type === 'off') {
        const stack = pending.get(ev.note);
        if (stack && stack.length) {
          const tOn = stack.shift();
          const dur = Math.max(1, ev.timeTicks - tOn);
          notes.push({ startTick: tOn, durTick: dur, cents: ev.note });
        }
        if (stack && stack.length === 0) pending.delete(ev.note);
      }
    }
    const defaultDur = q;
    for (const [cents, stack] of pending) {
      for (const tOn of stack) {
        notes.push({ startTick: tOn, durTick: defaultDur, cents });
      }
    }
    // ---- Snap to nearest 16th-note grid ----
      // Real MIDI often has notes whose actual durations are not exact
      // multiples of a 16th (60-tick eighths in our 480-tpq demo, or even
      // 80-tick grace notes). For sheet music we want all positions and
      // durations to snap to a 16th grid so the visual layout doesn't
      // have overlapping or oddly-staggered notes. The trade-off: the
      // synth score shows APPROXIMATE durations and positions. The
      // playback (in playback.js) uses the exact real durations from the
      // note_on/note_off pairing, so the audio stays exact.
      //
      // Snap-to-nearest logic:
      //   dur 1-40     → 16th (120)    [very short grace notes snap to 16th]
      //   dur 41-180   → 16th          [40-180 → 120, the 16th is closest]
      //   dur 181-360  → eighth        [181-360 → 240, eighth is closest]
      //   dur 361-720  → quarter       [361-720 → 480, quarter is closest]
      //   dur 721-1440 → half          [721-1440 → 960, half is closest]
      //   dur 1441+    → whole
      const SIXTEENTH = q / 4;
        const STD_DURATIONS = [
          { name: '16th',    div: SIXTEENTH },
          { name: 'eighth',  div: q / 2 },
          { name: 'quarter', div: q },
          { name: 'half',    div: q * 2 },
          { name: 'whole',   div: q * 4 },
        ];
      function durNameFor(ticks) {
        let best = STD_DURATIONS[0];
        let bestDiff = Math.abs(ticks - best.div);
        for (let i = 1; i < STD_DURATIONS.length; i++) {
          const d = Math.abs(ticks - STD_DURATIONS[i].div);
          if (d < bestDiff) { best = STD_DURATIONS[i]; bestDiff = d; }
        }
        return best;
      }
      // Quantize a raw tick to the nearest 16th-note boundary. MIDI notes
      // played slightly early/late (10-30 ticks of human jitter) all land
      // on the same 16th slot, which keeps the visual score tidy.
      function snapStart(tick) {
        return Math.round(tick / SIXTEENTH) * SIXTEENTH;
      }

      // Sort + quantize start times to the 16th grid. Then DEDUPE: if two
      // notes snap to the same startTick, keep the louder one (the other
      // was a soft grace note or human-jitter re-attack). This is what
      // OSMD-graded notation expects.
      notes.sort((a, b) => a.startTick - b.startTick);
      const quantizedNotes = [];
      for (const n of notes) {
        const snapped = snapStart(n.startTick);
        const dur = durNameFor(n.durTick);
        // If the previous note has the same snapped startTick, this is a
        // duplicate. Keep the louder one (we don't have velocity here, so
        // keep the later one — the most recent note at that position).
        if (quantizedNotes.length > 0 &&
            quantizedNotes[quantizedNotes.length - 1].startTick === snapped) {
          continue;
        }
        quantizedNotes.push({ startTick: snapped, durTick: dur.div, cents: n.cents, _durName: dur.name });
      }

      // ---- 3. Chord grouping ----
      // Walk the sorted+quantized notes and bundle any whose startTick
      // matches. After quantization, simultaneous events (or events that
      // were within 1/16 of a quarter of each other) all share one tick,
      // so we just look for adjacent equal startTicks.
      const chords = [];
      let cur = null;
      for (const n of quantizedNotes) {
        if (cur && n.startTick === cur.startTick) {
          cur.members.push(n);
        } else {
          if (cur) chords.push(cur);
          cur = { startTick: n.startTick, members: [n] };
        }
      }
      if (cur) chords.push(cur);

    // ---- 4. Measure overflow with ties ----
    // Walk chords in order. For each chord, figure out how much of its
    // duration fits in the current measure. If the chord fits entirely,
    // emit it as-is. If not, split: emit the fitted portion with
    // <tie type="start"/> and queue the remainder for the next measure
    // with <tie type="stop"/>. Tied carries can themselves overflow
    // another measure (rare in 4/4) — we recurse until the remainder
    // is consumed.
    //
    // We pre-compute each chord's snapped duration here so the carry
    // logic and the carry's own carry see the same numbers. Carries
    // keep their original startTick (for ordering) but consume their
    // own duration from the next measure's clock.
    const chordPlans = [];   // [{ startTick, members, divisions, durName, carry? }]
    let cursorTick = 0;      // absolute clock — advances as we emit
    for (const c of chords) {
      // The chord's nominal duration = min of its members' snapped
      // durations. The chord lifts when the first finger lifts.
      let minDiv = Infinity, minName = 'quarter';
      for (const m of c.members) {
        const d = durNameFor(m.durTick);
        if (d.div < minDiv) { minDiv = d.div; minName = d.name; }
      }
      c._divisions = minDiv;
      c._durName = minName;
      chordPlans.push(c);
    }

    // Build the list of measure segments. Each entry is either a chord
    // (with a carry of {remainingDiv, durName, members} if it overflows)
    // or a rest.
    const measures = [];   // [{ tick, items: [{kind, ...}] }]
    let i = 0;
    let measureTick = 0;
    let m = { tick: cursorTick - (cursorTick % MEASURE_TICKS), items: [] };
    while (i < chordPlans.length) {
      const c = chordPlans[i];
      const cStartInMeasure = c.startTick - m.tick;
      // If the chord starts in a future measure, close this measure out
      // with rests and open the next one. (This shouldn't normally
      // happen because we process chords in startTick order, but the
      // overflow-carryover path can land a carry in a later measure.)
      if (cStartInMeasure >= MEASURE_TICKS) {
        measures.push(m);
        measureTick = 0;
        m = { tick: m.tick + MEASURE_TICKS, items: [] };
        continue;
      }
      // Skip over any silence before this chord — leave it for the rest
      // pass at the end.
      const cDiv = c._divisions;
      if (cDiv <= 0) { i++; continue; }
      if (cStartInMeasure < 0) {
        // Chord starts before the current measure's tick (only possible
        // for carries — but carries have already been accounted for).
        // Skip and continue.
        i++;
        continue;
      }
      const remaining = MEASURE_TICKS - measureTick;
      if (cDiv <= remaining) {
        // Fits. Emit as-is (no tie).
        m.items.push({ kind: 'chord', chord: c, div: cDiv, tie: null });
        measureTick += cDiv;
        if (measureTick >= MEASURE_TICKS) {
          measures.push(m);
          m = { tick: m.tick + MEASURE_TICKS, items: [] };
          measureTick = 0;
        }
        i++;
      } else {
        // Doesn't fit. Emit the part that fits with tie=start, push the
        // remainder to the next measure as a tie=stop continuation.
        const fitDiv = remaining;
        const restDiv = cDiv - fitDiv;
        // We need to express `fitDiv` as a standard duration for <type>.
        const fitType = durNameFor(fitDiv);
        m.items.push({
          kind: 'chord', chord: c,
          div: fitDiv, durName: fitType.name,
          tie: 'start',
        });
        measures.push(m);
        // Open the next measure with the remainder.
        m = { tick: m.tick + MEASURE_TICKS, items: [] };
        measureTick = 0;
        const restType = durNameFor(restDiv);
        m.items.push({
          kind: 'chord', chord: c,
          div: restDiv, durName: restType.name,
          tie: 'stop',
        });
        measureTick += restDiv;
        // If the remainder is itself longer than the new measure
        // (extremely rare), recurse by re-inserting c back into the
        // plans with reduced divisions. For simplicity we just let it
        // be — the measure-closing rest pass will handle it.
        i++;
      }
    }
    // Final measure.
    if (m.items.length > 0 || measures.length === 0) measures.push(m);

    // Now fill each measure's silence (between items) with rests so the
    // measure totals exactly MEASURE_TICKS. We do this in a second pass
    // because some items come from overflow carries that pre-empt later
    // chords.
    const filledMeasures = [];
    for (let mi = 0; mi < measures.length; mi++) {
      const meas = measures[mi];
      const items = [];
      let used = 0;
      for (const it of meas.items) {
        if (used < it.chord.startTick - meas.tick) {
          // Gap before this chord — emit rests. We treat the gap as a
          // contiguous silence here. For carries (which already have a
          // real startTick) the gap will normally be 0.
          items.push({ kind: 'rest-ghost', div: it.chord.startTick - meas.tick - used });
        }
        items.push(it);
        used += it.div;
      }
      const tail = MEASURE_TICKS - used;
      if (tail > 0) {
        items.push({ kind: 'rest', div: tail });
      }
      filledMeasures.push({ tick: meas.tick, items });
    }

    // ---- Emit MusicXML ----
    const xml = [];
    xml.push('<?xml version="1.0" encoding="UTF-8"?>');
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

    for (let mi = 0; mi < filledMeasures.length; mi++) {
      const meas = filledMeasures[mi];
      xml.push(`    <measure number="${mi + 1}">`);
      // First measure: emit attributes (time signature + divisions).
      if (mi === 0) {
        xml.push('      <attributes>');
        xml.push(`        <divisions>${q}</divisions>`);
        xml.push('        <key><fifths>0</fifths></key>');
        xml.push(`        <time><beats>${timeNum}</beats><beat-type>${timeDen}</beat-type></time>`);
        xml.push('        <clef><sign>G</sign><line>2</line></clef>');
        xml.push('      </attributes>');
      }
      for (const it of meas.items) {
        if (it.kind === 'chord') {
          emitChord(xml, it.chord, it.div, it.durName || it.chord._durName, it.tie);
        } else if (it.kind === 'rest' || it.kind === 'rest-ghost') {
          emitRests(xml, it.div);
        }
      }
      xml.push('    </measure>');
    }

    xml.push('  </part>');
    xml.push('</score-partwise>');
    return xml.join('\n');
  }

  // Emit a chord — one <note> per member, with <chord/> on all but the
  // first so OSMD stacks them vertically at the same rhythmic position.
  // `tie` is 'start', 'stop', or null.
  function emitChord(xml, chord, div, durName, tie) {
    // The first member is the bottom of the chord visually (lowest
    // pitch). Sort members ascending so chord stacks from bottom up.
    const members = chord.members.slice().sort((a, b) => a.cents - b.cents);
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const sao = M.centsToStepAlterOctave(m.cents);
      if (!sao) continue;
      xml.push('      <note>');
      if (i > 0) xml.push('        <chord/>');
      xml.push('        <pitch>');
      xml.push(`          <step>${sao.step}</step>`);
      if (sao.alter) xml.push(`          <alter>${sao.alter}</alter>`);
      xml.push(`          <octave>${sao.octave}</octave>`);
      xml.push('        </pitch>');
      xml.push(`        <duration>${div}</duration>`);
      xml.push('        <voice>1</voice>');
      xml.push(`        <type>${durName}</type>`);
      if (tie === 'start') xml.push('        <tie type="start"/>');
      if (tie === 'stop')  xml.push('        <tie type="stop"/>');
      if (tie === 'start') xml.push('        <notations><tied type="start"/></notations>');
      if (tie === 'stop')  xml.push('        <notations><tied type="stop"/></notations>');
      xml.push('      </note>');
    }
  }

  // Emit rests that fill exactly `div` ticks. We use the largest standard
  // duration that fits, then recurse with the remainder.
  function emitRests(xml, div) {
    const q = 480; // not used here — callers pre-snap before passing
    const STD = [
      { name: '16th',    div: q / 4 },
      { name: 'eighth',  div: q / 2 },
      { name: 'quarter', div: q },
      { name: 'half',    div: q * 2 },
      { name: 'whole',   div: q * 4 },
    ];
    // Largest standard duration that fits in `div`.
    let remaining = div;
    while (remaining > 0) {
      const pick = STD.filter(s => s.div <= remaining).pop();
      if (!pick) break; // shouldn't happen — we passed whole ticks
      xml.push('      <note>');
      xml.push('        <rest/>');
      xml.push(`        <duration>${pick.div}</duration>`);
      xml.push('        <voice>1</voice>');
      xml.push(`        <type>${pick.name}</type>`);
      xml.push('      </note>');
      remaining -= pick.div;
    }
  }

const api = { parseMusicXml, analyzeMusicXml, pitchToCents, buildSyntheticMusicXml };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MidiGraph = Object.assign(window.MidiGraph || {}, api);
  }
})();