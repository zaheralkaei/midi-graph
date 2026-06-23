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
  const sheetPanel = document.getElementById('sheet-panel');
  const statsGrid = document.getElementById('stats-grid');
  const topTransitionsEl = document.getElementById('top-transitions');
  const sheetContainer = document.getElementById('sheet-container');
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const playbackInfo = document.getElementById('playback-info');

  let currentGraphController = null;
  let currentPlayback = null;
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
    playBtn.disabled = true;
    stopBtn.disabled = true;
    isPlaying = false;
  }

  function renderStats(stats) {
    statsGrid.innerHTML = '';
    const cells = [
      { label: 'Total notes', value: stats.note_count, sub: `${stats.unique_note_count} unique pitches` },
      { label: 'Transitions', value: stats.transition_count, sub: 'note → next-note pairs' },
      { label: 'Self-loops', value: stats.self_loop_count, sub: `${(stats.self_loop_share * 100).toFixed(1)}% of all transitions` },
      { label: 'Pitch range', value: stats.pitch_range, sub: '' },
    ];
    for (const c of cells) {
      const el = document.createElement('div');
      el.className = 'stat';
      el.innerHTML = `
        <div class="label">${c.label}</div>
        <div class="value"${c.label === 'Pitch range' ? ' style="font-size: 15px;"' : ''}>${c.value}</div>
        ${c.sub ? `<div class="sub">${c.sub}</div>` : ''}
      `;
      statsGrid.appendChild(el);
    }
    // ALL transitions, sorted by probability descending. 193 transitions on
    // one line would be unreadable; render as a vertical scrollable list
    // capped at ~12 visible rows (CSS scrolls the rest).
    topTransitionsEl.innerHTML = '<ol class="transition-list">' +
      stats.all_transitions
        .map(t => `<li><code>${t.from} → ${t.to}</code><span class="pct">${(t.probability * 100).toFixed(1)}%</span></li>`)
        .join('') +
      '</ol>';
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
    renderStats(result.stats);

    const graphContainer = document.getElementById('graph');
    currentGraphController = M.render(graphContainer, result.graph);
    graphPanel.classList.remove('hidden');

    // Wire playback callbacks so the graph glows when each pitch is sounding.
    // Guard against the controller being null in case the graph was torn down
    // (e.g. during resetState) before the callback fires.
    currentPlayback = M.buildPlayback(result.events, result.ticksPerQuarter, {
      onNoteOn: (cents) => currentGraphController && currentGraphController.setActive(cents, true),
      onNoteOff: (cents) => currentGraphController && currentGraphController.setActive(cents, false),
    });
    playBtn.disabled = false;
    stopBtn.disabled = true;
    playbackInfo.textContent = `${currentPlayback.noteCount} notes ready. Click Play to start.`;
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

  playBtn.addEventListener('click', async () => {
    if (!currentPlayback || isPlaying) return;
    await Tone.start();
    isPlaying = true;
    playBtn.disabled = true;
    stopBtn.disabled = false;
    playbackInfo.textContent = `Playing ${currentPlayback.noteCount} notes…`;
    await currentPlayback.play();
    isPlaying = false;
    playBtn.disabled = false;
    stopBtn.disabled = true;
    playbackInfo.textContent = `Played ${currentPlayback.noteCount} notes.`;
  });

  stopBtn.addEventListener('click', () => {
    if (!currentPlayback) return;
    currentPlayback.stop();
    isPlaying = false;
    playBtn.disabled = false;
    stopBtn.disabled = true;
    playbackInfo.textContent = 'Stopped.';
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