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
    document.getElementById('load-demo-quartertones').disabled = true;
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
  const loadDemoQuartBtn = document.getElementById('load-demo-quartertones');
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
    topTransitionsEl.innerHTML = stats.top_transitions
      .map(t => `<code>${t.from} → ${t.to}</code><span class="pct">${(t.probability * 100).toFixed(1)}%</span>`)
      .join(' &nbsp; ');
    statsPanel.classList.remove('hidden');
  }

  // Load a MIDI file (Uint8Array of bytes).
  function loadMidiBytes(bytes, label) {
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
    const bytes = new Uint8Array(buf);
    const detected = M.detectFileType(bytes, file.name);

    if (detected.type === 'midi') {
      loadMidiBytes(bytes, file.name);
    } else if (detected.type === 'musicxml') {
      // Decode text here (TextDecoder is forgiving about BOM and encoding).
      const text = new TextDecoder('utf-8').decode(bytes);
      await loadMusicXmlText(text, file.name);
    } else if (detected.type === 'mxl') {
      // Compressed MusicXML: unzip, read META-INF/container.xml to find the
      // rootfile path, extract that, then parse as MusicXML.
      const errs = {};
      const xmlText = M.extractMxl(bytes, errs);
      if (!xmlText) {
        const msg = 'Could not read .mxl archive: ' + (errs.reason || 'unknown error');
        showError(msg);
        playbackInfo.textContent = msg;
        return;
      }
      await loadMusicXmlText(xmlText, file.name);
    } else {
      // Unknown — show the reason, which already includes the helpful hint
      // based on the file's extension.
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
    const resp = await fetch('examples/minuet.mid');
    if (!resp.ok) {
      playbackInfo.textContent = 'Demo MIDI fetch failed (status ' + resp.status + ').';
      return;
    }
    const buf = await resp.arrayBuffer();
    loadMidiBytes(new Uint8Array(buf), 'examples/minuet.mid');
  });

  loadDemoXmlBtn.addEventListener('click', async () => {
    playbackInfo.textContent = 'Loading demo MusicXML…';
    const resp = await fetch('examples/minuet.musicxml');
    if (!resp.ok) {
      playbackInfo.textContent = 'Demo MusicXML fetch failed (status ' + resp.status + ').';
      return;
    }
    const text = await resp.text();
    await loadMusicXmlText(text, 'examples/minuet.musicxml');
  });

  loadDemoQuartBtn.addEventListener('click', async () => {
    playbackInfo.textContent = 'Loading quarter-tone demo…';
    const resp = await fetch('examples/quartertones.musicxml');
    if (!resp.ok) {
      playbackInfo.textContent = 'Quarter-tone demo fetch failed (status ' + resp.status + ').';
      return;
    }
    const text = await resp.text();
    await loadMusicXmlText(text, 'examples/quartertones.musicxml');
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
})();