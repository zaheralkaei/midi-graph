// app.js — wires together file picker, MIDI/MusicXML parser, stats panel,
// graph, sheet music, and playback. Single-page, no server.

(function () {
  const M = window.MidiGraph;

  // Defensive guards: if a CDN fallback chain still failed (offline mode,
  // broken corporate proxy, etc.), the page should fail with a useful
  // message instead of throwing cryptic "Tone is not defined" errors.
  // We disable the affected UI controls so clicks don't throw.
  if (typeof Tone === 'undefined') {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="background:#ff5252;color:#fff;padding:12px;text-align:center;">' +
      'Tone.js failed to load — audio playback is disabled. Check your network connection.</div>');
    document.getElementById('play-btn').disabled = true;
    document.getElementById('stop-btn').disabled = true;
  }
  if (typeof d3 === 'undefined') {
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="background:#ff5252;color:#fff;padding:12px;text-align:center;">' +
      'D3 v7 failed to load — the transition graph is disabled. Check your network connection.</div>');
    document.getElementById('file').disabled = true;
    document.getElementById('load-demo-midi').disabled = true;
    document.getElementById('load-demo-xml').disabled = true;
  }

  // Show a parse error near the upload control. Cleared on next successful
  // load (see finishLoad).
  const errorDisplay = document.getElementById('error-display');
  function showError(msg) {
    errorDisplay.textContent = msg;
    errorDisplay.classList.remove('hidden');
  }
  function clearError() {
    errorDisplay.textContent = '';
    errorDisplay.classList.add('hidden');
  }

  const fileInput = document.getElementById('file');
  const loadDemoMidiBtn = document.getElementById('load-demo-midi');
  const loadDemoXmlBtn = document.getElementById('load-demo-xml');
  const filenameDisplay = document.getElementById('filename-display');
  const statsPanel = document.getElementById('stats-panel');
  const graphPanel = document.getElementById('graph-panel');
  const harmonicPanel = document.getElementById('harmonic-panel');
  const sheetPanel = document.getElementById('sheet-panel');
  const statsGrid = document.getElementById('stats-grid');
  const topTransitionsEl = document.getElementById('top-transitions');
  const harmonicStatsGrid = document.getElementById('harmonic-stats-grid');
  const harmonicTopTransitionsEl = document.getElementById('harmonic-top-transitions');
  const sheetContainer = document.getElementById('sheet-container');
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const playbackInfo = document.getElementById('playback-info');

  let currentGraphController = null;
  let currentHarmonicController = null;
  let currentPlayback = null;
  let currentResult = null;        // Phase 1: keep the analyze result so we
                                   // can re-render the graph when the user
                                   // picks a different track.
  let currentMelodicIndex = 0;     // INDEX into trackAnalyses (NOT a
                                  // trackIndex — they're different because
                                  // some MIDI files have silent/meta-only
                                  // tracks at the start that get filtered
                                  // out). The select value is the array
                                  // index, not the MIDI track number.
  let currentMelodicStats = null;  // Cached melodic stats so
                                  // renderHarmonicView can re-render the
                                  // Summary panel when the user changes
                                  // the harmonic window size.
  let currentChordWindows = null;  // Phase 3: cached chord windows used to
                                   // re-run the classifier with a different
                                   // windowTicks when the user changes the
                                   // dropdown. Recomputed on demand; not
                                   // part of the analyze result so we don't
                                   // pay for every possible window size up
                                   // front.
  let isPlaying = false;

  function resetState() {
    // Stop playback FIRST so its onNoteOff callbacks don't fire on a graph
    // we're about to destroy. (The callback closure captures the graph
    // controller reference, so destroying the graph mid-stop would throw.)
    if (currentPlayback) {
      currentPlayback.stop();
      currentPlayback = null;
    }
    if (currentGraphController) {
      currentGraphController.destroy();
      currentGraphController = null;
    }
    M.clearSheet();
    sheetPanel.classList.add('hidden');
    statsPanel.classList.add('hidden');
    graphPanel.classList.add('hidden');
    harmonicPanel.classList.add('hidden');
    if (currentHarmonicController) {
      currentHarmonicController.destroy();
      currentHarmonicController = null;
    }
    // Phase 3: cancel any pending chord-window glow callbacks.
    if (typeof clearChordGlow === 'function') clearChordGlow();
    // Clear innerHTML so large previous files don't leave stale DOM
    // (memory pressure on consecutive large loads).
    document.getElementById('stats-grid').innerHTML = '';
    document.getElementById('top-transitions').innerHTML = '';
    document.getElementById('harmonic-stats-grid').innerHTML = '';
    document.getElementById('harmonic-top-transitions').innerHTML = '';
    const chordSeq = document.getElementById('chord-sequence-list');
    if (chordSeq) chordSeq.innerHTML = '';
    playBtn.disabled = true;
    stopBtn.disabled = true;
    isPlaying = false;
  }

  function renderStatsGrid(gridEl, cells) {
    gridEl.innerHTML = '';
    for (const c of cells) {
      const el = document.createElement('div');
      el.className = 'stat';
      el.innerHTML = `
        <div class="label">${c.label}</div>
        <div class="value"${c.label === 'Pitch range' || c.label === 'Chord range' ? ' style="font-size: 15px;"' : ''}>${c.value}</div>
        ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
      `;
      gridEl.appendChild(el);
    }
  }

  function renderTransitionsList(el, transitions) {
    el.innerHTML = '<ol class="transition-list">' +
      transitions
        .map(t => `<li><code>${t.from} → ${t.to}</code><span class="pct">${(t.probability * 100).toFixed(1)}%</span></li>`)
        .join('') +
      '</ol>';
  }

  function renderStats(stats, chordGraph) {
    // Melodic stats: note count, transitions, self-loops, pitch range.
    renderStatsGrid(statsGrid, [
      { label: 'Total notes', value: stats.note_count, sub: `${stats.unique_note_count} unique pitches` },
      { label: 'Transitions', value: stats.transition_count, sub: 'note → next-note pairs' },
      { label: 'Self-loops', value: stats.self_loop_count, sub: `${(stats.self_loop_share * 100).toFixed(1)}% of all transitions` },
      { label: 'Pitch range', value: stats.pitch_range, sub: '' },
    ]);
    renderTransitionsList(topTransitionsEl, stats.all_transitions);

    // Harmonic stats: chord count, transitions, self-loops, "chord range"
    // (the unique chord labels sorted alphabetically). chordGraph comes
    // from buildChordTransitionGraph and has the same shape as the
    // melodic graph (nodes with count + frequency, links with count +
    // value). For monophonic files the chord graph only contains
    // single-pitch "chords" (one pitch per window, no harmonic content
    // to summarize) — even if nodes exist, render a placeholder so the
    // Summary matches what the harmonic graph above is showing (which
    // for monophonic files displays the "monophonic" notice instead of
    // the graph). Otherwise the two panels disagree and the user sees
    // chord stats for a file the detector flagged as monophonic.
    if (currentResult && currentResult.monophonic) {
      harmonicStatsGrid.innerHTML = '<div class="stat"><div class="sub" style="font-size: 13px;">No chord data — this file appears to be monophonic.</div></div>';
      harmonicTopTransitionsEl.innerHTML = '';
    } else if (chordGraph && chordGraph.nodes && chordGraph.nodes.length > 0) {
      const nodeCount = chordGraph.nodes.length;
      const linkCount = chordGraph.links.length;
      const totalTransitions = chordGraph.links.reduce((s, l) => s + l.count, 0);
      // "Chord range" = the alphabetically-extreme chord labels in the
      // progression, e.g. "A minor → G7". This mirrors the melodic
      // pitch range but operates on chord labels.
      const sorted = chordGraph.nodes.map(n => n.id).sort();
      const chordRange = sorted.length <= 2
        ? sorted.join(' → ')
        : `${sorted[0]} … ${sorted[sorted.length - 1]}`;
      renderStatsGrid(harmonicStatsGrid, [
        { label: 'Unique chords', value: nodeCount, sub: `${chordGraph.links.reduce((s, l) => s + l.value, 0).toFixed(2)} avg transition prob.` },
        { label: 'Transitions', value: linkCount, sub: `${totalTransitions} total chord → chord pairs` },
        { label: 'Self-loops', value: chordGraph.links.filter(l => l.source === l.target).length, sub: 'chord repeats next time' },
        { label: 'Chord range', value: chordRange, sub: '' },
      ]);
      renderTransitionsList(harmonicTopTransitionsEl, chordGraph.links.map(l => ({
        from: l.source, to: l.target, probability: l.value,
      })));
    } else {
      // No monophonic flag AND no chord nodes — edge case (e.g. an
      // empty file that parsed cleanly but had no notes).
      harmonicStatsGrid.innerHTML = '<div class="stat"><div class="sub" style="font-size: 13px;">No chord data — empty file.</div></div>';
      harmonicTopTransitionsEl.innerHTML = '';
    }
    statsPanel.classList.remove('hidden');
  }

  // Load a MIDI file (Uint8Array of bytes).
  async function loadMidiBytes(bytes, label) {
    resetState();
    clearError();
    filenameDisplay.textContent = label;
    let result;
    try {
      result = M.analyzeMidi(bytes);
    } catch (e) {
      const msg = 'Error parsing MIDI: ' + e.message;
      showError(msg);
      playbackInfo.textContent = msg;
      return;
    }
    finishLoad(result);
    // Render sheet music for MIDI too — synthesize MusicXML from the parsed
    // events and pass it to OSMD. MIDI doesn't carry notation data, so the
    // rendered score uses each note's actual duration (note_on → note_off
    // pairs) and the standard 5 MusicXML note types (whole/half/quarter/
    // eighth/16th) but no dynamics, articulations, or key signature. Still
    // much better than "no sheet music for MIDI files" — the user can read
    // the melody.
    let sheetRendered = false;
    try {
      // Try webmscore first for professional-grade engraving (proper beam
      // grouping, voice separation, slurs, articulations, key signature).
      // If the WASM fails to load, fails to convert, or the worker dies,
      // we silently fall back to the hand-rolled synth. The user always
      // sees sheet music — they just don't see "engine failed" errors
      // if webmscore isn't available.
      let xmlText = null;
      if (M.convertMidiViaWebMscore) {
        xmlText = await M.convertMidiViaWebMscore(bytes);
        if (xmlText) console.log('[synth] used webmscore (high-fidelity)');
      }
      if (!xmlText) {
        // Fall back to hand-rolled synth. Pass the full analyze result so
        // it picks the best track and uses the file's time signature.
        xmlText = M.buildSyntheticMusicXml(result);
        if (xmlText) console.log('[synth] used local synth (webmscore unavailable)');
      }
      const syntheticXml = xmlText;
      if (M.isSheetAvailable()) {
        sheetPanel.classList.remove('hidden');
        await M.renderSheet(sheetContainer, syntheticXml);
        sheetRendered = sheetContainer.children.length > 0;
      } else {
        sheetPanel.classList.remove('hidden');
        sheetContainer.innerHTML = '<p style="color: var(--muted);">Sheet music renderer (OSMD) failed to load. The transition graph still works.</p>';
      }
    } catch (e) {
      // Synthetic MusicXML synthesis failed (very rare). Don't block the
      // graph — just hide the sheet panel and log.
      console.warn('Synthetic MusicXML render failed:', e);
      sheetPanel.classList.add('hidden');
    }
    if (sheetRendered) {
      sheetPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Load a MusicXML file (text).
  async function loadMusicXmlText(xmlText, label) {
    resetState();
    clearError();
    filenameDisplay.textContent = label;
    let result;
    try {
      result = M.analyzeMusicXml(xmlText);
    } catch (e) {
      const msg = 'Error parsing MusicXML: ' + e.message;
      showError(msg);
      playbackInfo.textContent = msg;
      return;
    }
    finishLoad(result);
    // Render sheet music. Sheet panel only shows for MusicXML files.
    let sheetRendered = false;
    if (M.isSheetAvailable()) {
      sheetPanel.classList.remove('hidden');
      await M.renderSheet(sheetContainer, xmlText);
      sheetRendered = sheetContainer.children.length > 0;
    } else {
      sheetPanel.classList.remove('hidden');
      sheetContainer.innerHTML = '<p style="color: var(--muted);">Sheet music renderer (OSMD) failed to load from CDN. The transition graph still works.</p>';
    }
    // Bring the sheet into view only if it actually rendered — scrolling to
    // an error message is more annoying than helpful.
    if (sheetRendered) {
      sheetPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function finishLoad(result) {
    // Phase 1: cache the full analyze result so the track picker can
    // re-render the graph without re-parsing the file.
    currentResult = result;
    currentMelodicIndex = 0;   // default to first track
    populateTrackPicker(result);
    renderMelodicView();
    graphPanel.classList.remove('hidden');

    // Phase 3: render the harmonic graph panel.
    renderHarmonicView();

    // Wire playback callbacks so the graph glows when each pitch is sounding.
    // The onNoteOn/onNoteOff callbacks receive the original event (with
    // its track field) so we can do track-aware glow — when the user
    // picks a single track in the picker, only that track's notes glow
    // on the graph. Playback itself always uses the MERGED events so the
    // user hears the whole piece regardless of which track the graph
    // visualizes.
    //
    // We resolve the selected trackIndex DYNAMICALLY (at callback time)
    // so that switching the track picker mid-playback re-targets the
    // glow without rebuilding the playback instance.
    const melodicTrackIndex = () => {
      if (!currentResult || !currentResult.trackAnalyses) return null;
      if (currentMelodicIndex < 0
          || currentMelodicIndex >= currentResult.trackAnalyses.length) return null;
      return currentResult.trackAnalyses[currentMelodicIndex].trackIndex;
    };
    currentPlayback = M.buildPlayback(result.events, result.ticksPerQuarter, {
      onNoteOn: (cents, event) => {
        const sel = melodicTrackIndex();
        if (sel !== null && event && event.track !== sel) return;
        if (currentGraphController) currentGraphController.setActive(cents, true);
      },
      onNoteOff: (cents, event) => {
        const sel = melodicTrackIndex();
        if (sel !== null && event && event.track !== sel) return;
        if (currentGraphController) currentGraphController.setActive(cents, false);
      },
    });
    playBtn.disabled = false;
    stopBtn.disabled = true;
    playbackInfo.textContent = `${currentPlayback.noteCount} notes ready. Click Play to start.`;
  }

  // Phase 3: render the harmonic graph + chord sequence panel.
  // Shows the chord-transition graph from the current window size
  // (default quarter note). Shows a notice instead of the graph when
  // the file is monophonic — every chord would just be a single note
  // and the graph wouldn't be informative. Hides the whole panel for
  // non-MIDI files (MusicXML/MXL) since the analyze path doesn't
  // currently compute chord sequences for them.
  function renderHarmonicView() {
    if (!currentResult || !M.chordSequence) return;
    const harmonicNotice = document.getElementById('harmonic-monophonic-notice');
    // analyzeMusicXml now returns the same shape as analyzeMidi
    // (trackAnalyses, chordWindows, monophonic) so the harmonic
    // panel works for both file types. The branch below is kept
    // for defensive handling of an older result object that might
    // still be in flight (e.g. during a partial state where the
    // chordSequence call didn't complete).
    if (!currentResult.chordWindows && !currentResult.monophonic) {
      harmonicPanel.classList.add('hidden');
      return;
    }
    if (currentResult.monophonic) {
      // Monophonic file — show notice, hide the graph + controls.
      harmonicPanel.classList.remove('hidden');
      harmonicPanel.querySelector('.graph-wrap').style.display = 'none';
      harmonicPanel.querySelector('.chord-sequence-panel').style.display = 'none';
      if (harmonicNotice) harmonicNotice.hidden = false;
      return;
    }
    harmonicPanel.classList.remove('hidden');
    harmonicPanel.querySelector('.graph-wrap').style.display = '';
    harmonicPanel.querySelector('.chord-sequence-panel').style.display = '';
    if (harmonicNotice) harmonicNotice.hidden = true;
    // Compute chord windows with the current window size.
    const windowSelect = document.getElementById('harmonic-window');
    const windowTicks = windowSelect ? parseInt(windowSelect.value, 10) : 480;
    currentChordWindows = M.chordSequence(currentResult.events, {
      ticksPerQuarter: currentResult.ticksPerQuarter,
      windowTicks,
    });
    // Phase 3 fix: scheduleChordGlow reads from currentResult.chordWindows,
    // so the playback glow must use the SAME windows the graph is showing.
    // Without this, changing the harmonic window and then pressing Play
    // would highlight nodes at the wrong times (jumping from chord to
    // chord with no smooth transition because the schedule was built
    // with the old, smaller window's time base).
    currentResult.chordWindows = currentChordWindows;
    const chordGraph = M.buildChordTransitionGraph(currentChordWindows);
    // Also store the chord graph so the Summary panel can re-render
    // its harmonic column when the window size changes.
    currentResult.chordGraph = chordGraph;
    // Destroy any previous harmonic controller so we don't leak D3 listeners.
    if (currentHarmonicController) {
      currentHarmonicController.destroy();
      currentHarmonicController = null;
    }
    const harmonicContainer = document.getElementById('harmonic-graph');
    currentHarmonicController = M.render(harmonicContainer, chordGraph, {
      mode: 'chord',
      zoomButtonPrefix: 'harmonic-',
      controlPrefix: 'harmonic-',
    });
    // Source label: how many windows, how many unique chords.
    const sourceLabel = document.getElementById('harmonic-source-label');
    if (sourceLabel) {
      const nonSilence = currentChordWindows.filter(w => w.label !== '(silence)').length;
      sourceLabel.textContent = `· ${nonSilence} windows · ${chordGraph.nodes.length} unique chords`;
    }
    // Chord sequence list (collapsed adjacent duplicates, silence skipped).
    renderChordSequenceList(currentChordWindows);
    // Re-render the Summary panel's harmonic column so the stats
    // grid + chord transitions list reflect the new window size.
    if (typeof renderStats === 'function' && currentMelodicStats) {
      renderStats(currentMelodicStats, chordGraph);
    }
    // Wire the harmonic controls (window select + sliders + zoom).
    wireHarmonicControls();
  }

  // Render the chord-sequence list: the actual chord progression
  // (with adjacent duplicates collapsed) so the user can read what the
  // graph is showing. Each entry: [pitch label] | [count × in sequence]
  function renderChordSequenceList(windows) {
    const listEl = document.getElementById('chord-sequence-list');
    if (!listEl) return;
    const seq = [];
    let prev = null;
    let count = 0;
    for (const w of windows) {
      if (w.label === '(silence)') continue;
      if (w.label !== prev) {
        if (prev) seq.push({ label: prev, count });
        prev = w.label;
        count = 1;
      } else {
        count++;
      }
    }
    if (prev) seq.push({ label: prev, count });
    if (!seq.length) {
      listEl.innerHTML = '<li style="color: var(--muted);">(no chords detected)</li>';
      return;
    }
    listEl.innerHTML = seq
      .map(c => `<li><code>${c.label}</code><span class="pct">×${c.count}</span></li>`)
      .join('');
  }

  // Phase 3: wire up the harmonic-panel controls. Safe to call multiple
  // times — listeners are idempotent because they're stored on the
  // elements themselves (only the FIRST wired listener survives).
  let harmonicControlsWired = false;
  function wireHarmonicControls() {
    if (harmonicControlsWired) return;
    harmonicControlsWired = true;
    const windowSelect = document.getElementById('harmonic-window');
    if (windowSelect) {
      windowSelect.onchange = () => renderHarmonicView();
    }
    const minProb = document.getElementById('harmonic-min-prob');
    const minProbVal = document.getElementById('harmonic-min-prob-val');
    if (minProb && minProbVal) {
      minProb.oninput = () => {
        minProbVal.textContent = minProb.value + '%';
        // The min-prob slider is read directly by M.render on each
        // rebuild — no need to re-call renderHarmonicView here.
      };
    }
    // Zoom buttons — D3-zoom is internal to M.render so we have to
    // dispatch via the controller's update pathway. Simpler: just
    // re-render, which loses the current pan/zoom. That's acceptable
    // for v1; can be improved later.
  }

  // Phase 1: populate the track-picker <select> with one option per
  // non-empty track. For single-track files (or files that don't have
  // per-track data, e.g. MusicXML) the picker is hidden — no point in
  // giving the user a one-option dropdown. For multi-track MIDI files
  // the picker is shown, with a hint about the auto-pick.
  function populateTrackPicker(result) {
    const select = document.getElementById('track-picker');
    const row = document.getElementById('track-picker-row');
    const hint = document.getElementById('track-picker-hint');
    if (!select || !row) return;     // safety: HTML missing
    const tracks = (result && result.trackAnalyses) || [];
    if (tracks.length <= 1) {
      row.classList.add('hidden');
      select.innerHTML = '';
      hint.textContent = '';
      return;
    }
    row.classList.remove('hidden');
    select.innerHTML = '';
    tracks.forEach((t, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);             // array index, not trackIndex
      opt.textContent = `${t.userLabel} — ${t.noteCount} notes · ${formatRange(t.pitchRange)}${t.isPercussion ? ' · drums' : ''}`;
      select.appendChild(opt);
    });
    // Add the "Auto (pick lead)" option at the end.
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = `Auto (pick lead) — Track ${(result.autoMelodic || 0) + 1}`;
    select.appendChild(autoOpt);
    // Default = first track in trackAnalyses (always array index 0).
    select.value = '0';
    currentMelodicIndex = 0;
    // Show the auto-pick suggestion as a small hint next to the dropdown.
    if (result.autoMelodic != null && result.autoMelodic !== 0) {
      hint.textContent = `(auto-pick suggests Track ${result.autoMelodic + 1})`;
    } else {
      hint.textContent = '';
    }
    // Wire change handler (only once — but we re-wire each time, the
    // old listener is harmless because we replace innerHTML above and
    // re-set the value, so the change event only fires on real user
    // interaction).
    select.onchange = () => {
      const v = select.value;
      if (v === 'auto') {
        // Map result.autoMelodic (a trackIndex) to its array index.
        const idx = tracks.findIndex(t => t.trackIndex === result.autoMelodic);
        currentMelodicIndex = idx >= 0 ? idx : 0;
      } else {
        currentMelodicIndex = parseInt(v, 10);
      }
      renderMelodicView();
    };
  }

  function formatRange([lo, hi]) {
    return `${centsToPitchString(lo)}–${centsToPitchString(hi)}`;
  }
  function centsToPitchString(cents) {
    return M.centsToPitch(cents);
  }

  // Phase 1: re-render the graph + stats + source label using the
  // currently-selected track's analysis. Destroys the previous graph
  // controller first so we don't leak D3 listeners or stale SVG nodes.
  // Falls back to the top-level (merged) graph for files that don't
  // have per-track data (MusicXML, MXL, or any future analyze*()).
  function renderMelodicView() {
    if (!currentResult) return;
    if (currentGraphController) {
      currentGraphController.destroy();
      currentGraphController = null;
    }
    const trackAnalyses = currentResult.trackAnalyses || [];
    const sourceLabel = document.getElementById('graph-source-label');
    let graph, stats, labelText;
    if (trackAnalyses.length > 0 &&
        currentMelodicIndex >= 0 &&
        currentMelodicIndex < trackAnalyses.length) {
      const track = trackAnalyses[currentMelodicIndex];
      graph = track.graph;
      stats = track.stats;
      labelText = track.isPercussion
        ? `· source: ${track.userLabel} (drums, ${track.noteCount} notes)`
        : `· source: ${track.userLabel} (${track.noteCount} notes)`;
    } else {
      // No per-track data (e.g. MusicXML) — use the merged graph.
      graph = currentResult.graph;
      stats = currentResult.stats;
      labelText = '';
    }
    sourceLabel.textContent = labelText;
    const graphContainer = document.getElementById('graph');
    currentGraphController = M.render(graphContainer, graph);
    // Save the melodic stats so renderHarmonicView can re-render
    // the Summary panel when the window size changes.
    currentMelodicStats = stats;
    // Pass the chord transition graph so the Summary panel can
    // populate the harmonic column. For monophonic files
    // chordGraph may be empty; renderStats handles that case
    // by showing a placeholder in the harmonic column.
    renderStats(stats, currentResult.chordGraph);
  }

  // Detect file type by inspecting the actual content (not the extension).
  // Users routinely rename .musicxml to .mid by accident, or export a .mxl
  // (compressed MusicXML) when the picker expects .musicxml. Sniffing the
  // first bytes is the only reliable signal. See midi.js's detectFileType.
  async function loadFile(file) {
    const buf = await file.arrayBuffer();
    await loadBytes(new Uint8Array(buf), file.name);
  }

  // Routes raw file bytes through content-sniffing detection, then to the
  // appropriate parser. Shared by the file picker handler and the demo
  // button handlers (which don't have a real File object).
  async function loadBytes(bytes, label) {
    // Reset state FIRST so a failed load doesn't leave the previous
    // file's panels visible (stale graph + stats + sheet music).
    // The specific parsers (loadMidiBytes, loadMusicXmlText) also call
    // resetState() but that's idempotent — calling it twice is harmless.
    resetState();
    clearError();
    const detected = M.detectFileType(bytes, label);

    if (detected.type === 'midi') {
      await loadMidiBytes(bytes, label);
    } else if (detected.type === 'musicxml') {
      const text = new TextDecoder('utf-8').decode(bytes);
      await loadMusicXmlText(text, label);
    } else if (detected.type === 'mxl') {
      const errs = {};
      const xmlText = M.extractMxl(bytes, errs);
      if (!xmlText) {
        const msg = 'Could not read .mxl archive: ' + (errs.reason || 'unknown error');
        showError(msg);
        playbackInfo.textContent = msg;
        return;
      }
      await loadMusicXmlText(xmlText, label);
    } else {
      const msg = 'Could not detect file type. ' + detected.reason;
      showError(msg);
      playbackInfo.textContent = msg;
    }
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) {
      const msg = 'File too large. Limit is 16 MB.';
      showError(msg);
      playbackInfo.textContent = msg;
      e.target.value = '';
      return;
    }
    await loadFile(file);
    e.target.value = '';  // reset so re-picking same file fires change next time
  });

  loadDemoMidiBtn.addEventListener('click', async () => {
    playbackInfo.textContent = 'Loading demo MIDI…';
    const resp = await fetch('examples/vp2-1all.mid');
    if (!resp.ok) {
      playbackInfo.textContent = 'Demo MIDI fetch failed (status ' + resp.status + ').';
      return;
    }
    const buf = await resp.arrayBuffer();
    await loadBytes(new Uint8Array(buf), 'examples/vp2-1all.mid');
  });

  loadDemoXmlBtn.addEventListener('click', async () => {
    playbackInfo.textContent = 'Loading demo MusicXML (.mxl)…';
    const resp = await fetch('examples/ya-tyra.mxl');
    if (!resp.ok) {
      playbackInfo.textContent = 'Demo MusicXML fetch failed (status ' + resp.status + ').';
      return;
    }
    const buf = await resp.arrayBuffer();
    // Routes through loadBytes → extractMxl → loadMusicXmlText.
    await loadBytes(new Uint8Array(buf), 'examples/ya-tyra.mxl');
  });

  // Phase 3: chord-window glow. Schedules Tone.Draw callbacks for each
  // chord window so the chord graph glows in sync with the audio. The
  // chord windows come from the current harmonic analysis (analyzeMidi's
  // chordWindows field) and use the same tickToSec as the note playback.
  // The schedule is stored so stop() can cancel it.
  let chordGlowTimers = [];
  function scheduleChordGlow(tickToSec) {
    // Cancel any previously-scheduled chord glows.
    for (const id of chordGlowTimers) Tone.Draw.cancel(id);
    chordGlowTimers = [];
    if (!currentResult || !currentResult.chordWindows) return;
    if (!currentHarmonicController) return;
    // Tone.Draw.schedule expects WALL-CLOCK time, not relative seconds.
    // See js/playback.js: notes are scheduled at
    // `Tone.now() + 0.1 + tickToSec(tick)` (the +0.1s is a buffer
    // before the first note). The chord glow must use the same
    // wall-clock base or it fires immediately as a "past time" event
    // and the rest of the schedule is lost. We capture startWallClock
    // at schedule time so the schedule is in sync with the note
    // playback's Tone.now() + 0.1 base.
    const startWallClock = Tone.now() + 0.1;
    for (const w of currentResult.chordWindows) {
      // Skip silence windows (no label).
      if (!w.label) continue;
      const startSec = tickToSec(w.startTick);
      const endSec = tickToSec(w.endTick);
      const onId = Tone.Draw.schedule(() => {
        if (currentHarmonicController) currentHarmonicController.setActiveChord(w.label, true);
        // Also update the playback-info text so the user can see the
        // chord transition even if the visual glow doesn't render.
        // (Tone.Draw callbacks fire only when the audio context is
        // running, so this only updates during playback.)
        if (playbackInfo) playbackInfo.textContent = `Now playing chord: ${w.label}`;
      }, startWallClock + startSec);
      const offId = Tone.Draw.schedule(() => {
        if (currentHarmonicController) currentHarmonicController.setActiveChord(w.label, false);
      }, startWallClock + endSec);
      chordGlowTimers.push(onId, offId);
    }
  }
  function clearChordGlow() {
    for (const id of chordGlowTimers) Tone.Draw.cancel(id);
    chordGlowTimers = [];
    if (currentHarmonicController) currentHarmonicController.clearActive();
  }

  playBtn.addEventListener('click', async () => {
    if (!currentPlayback || isPlaying) return;
    await Tone.start();
    isPlaying = true;
    playBtn.disabled = true;
    stopBtn.disabled = false;
    playbackInfo.textContent = `Playing ${currentPlayback.noteCount} notes…`;
    // Phase 3: schedule chord-window glow alongside the note playback.
    if (currentPlayback.tickToSec) scheduleChordGlow(currentPlayback.tickToSec);
    await currentPlayback.play();
    isPlaying = false;
    playBtn.disabled = false;
    stopBtn.disabled = true;
    playbackInfo.textContent = `Played ${currentPlayback.noteCount} notes.`;
    clearChordGlow();
  });

  stopBtn.addEventListener('click', () => {
    if (!currentPlayback) return;
    currentPlayback.stop();
    isPlaying = false;
    playBtn.disabled = false;
    stopBtn.disabled = true;
    playbackInfo.textContent = 'Stopped.';
    clearChordGlow();
  });

  // ----- Info modal (concept and implementation by Zaher Alkaei) -----
  // The modal is a plain <div role="dialog"> in index.html, hidden by
  // default. The "open" class on the wrapper fades it in and re-enables
  // pointer events; the wrapper has pointer-events: none when hidden so
  // it never intercepts page clicks underneath. Closing is idempotent
  // (a no-op if already closed) so ESC spam and double-clicks are safe.
  const infoBtn = document.getElementById('info-btn');
  const infoModal = document.getElementById('info-modal');
  const infoCloseBtn = infoModal.querySelector('.info-close');
  let lastFocusBeforeModal = null;  // restored on close for a11y

  function openInfo() {
    if (infoModal.classList.contains('open')) return;
    lastFocusBeforeModal = document.activeElement;
    infoModal.classList.add('open');
    infoModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('info-open');
    // Defer focus so the entry transition doesn't get a janky
    // outline flash on the close button.
    setTimeout(() => infoCloseBtn.focus(), 50);
  }
  function closeInfo() {
    if (!infoModal.classList.contains('open')) return;
    infoModal.classList.remove('open');
    infoModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('info-open');
    if (lastFocusBeforeModal && lastFocusBeforeModal.focus) {
      lastFocusBeforeModal.focus();
    }
  }
  infoBtn.addEventListener('click', openInfo);
  infoCloseBtn.addEventListener('click', closeInfo);
  // Any element with [data-info-dismiss="1"] (backdrop, close button)
  // closes the modal. We listen on the wrapper and filter by attribute
  // so we don't have to attach to each dismiss target individually.
  infoModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-info-dismiss="1"]')) closeInfo();
  });
  // ESC closes from anywhere; if the modal is already closed, this is
  // a no-op (closeInfo short-circuits).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && infoModal.classList.contains('open')) {
      e.preventDefault();
      closeInfo();
    }
  });

  // Spacebar toggles Play/Stop when no text input is focused. The
  // shortcut is also advertised inside the info modal so users know
  // it exists. Ignored if a modifier is held (so Ctrl+Space etc.
  // still work for OS shortcuts).
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (infoModal.classList.contains('open')) return;  // space inside modal scrolls, don't intercept
    e.preventDefault();
    if (isPlaying) stopBtn.click();
    else if (currentPlayback) playBtn.click();
  });
})();