// webmscore-bridge.js — high-fidelity MIDI → MusicXML conversion via
// LibreScore's webmscore (MuseScore 1.x compiled to WASM).
//
// webmscore gives us proper engraving (beam grouping, voice separation,
// slurs, articulations, dynamics) — the kind of notation a human would
// write by hand. The hand-rolled synth in musicxml.js is "good enough"
// but produces flat, mechanical-looking scores; webmscore produces
// sheet music that looks like it came out of MuseScore.
//
// Trade-offs:
//   - 9-13 MB of WASM (lazy-loaded — only fetched on first MIDI import).
//   - ~1-2 s first-load latency while the worker initializes.
//   - GPL v3 license (webmscore is built from MuseScore 1.x).
//
// Exposed as M.convertMidiViaWebMscore(bytes) → MusicXML string | null.
// The bridge caches the WebMscore instance across calls so subsequent
// MIDI imports don't pay the init cost. If the worker dies or returns
// garbage, we destroy the instance and let the next call re-init.

(function() {
  let instance = null;          // webmscore Worker wrapper (after first init)
  let initPromise = null;       // de-dupe concurrent init requests

  async function convertMidiViaWebMscore(midiBytes) {
    try {
      if (!instance) {
        await initWebMscore();
      }
      // webmscore's `load` takes (format, data, fonts, doLayout). For MIDI
      // we pass the Uint8Array directly; no fonts needed (we only render
      // to MusicXML, not to SVG which would need music fonts).
      // doLayout=true ensures proper measure layout.
      const score = await window.WebMscore.load('midi', midiBytes, [], true);
      const xml = await score.saveXml();
      try { console.log('[webmscore] title:', await score.title()); } catch (_) {}
      return xml;
    } catch (err) {
      console.warn('[webmscore] conversion failed, will fall back:', err);
      // Drop the broken instance so the next call can re-init from scratch.
      try { if (instance) await instance.destroy(true); } catch (_) {}
      instance = null;
      return null;
    }
  }

  async function initWebMscore() {
    // De-dupe: if two callers race to init, they share the same promise.
    if (initPromise) return initPromise;
    initPromise = (async () => {
      // Dynamic import — this triggers the 270 KB JS fetch (the worker
      // inside it then fetches the WASM + data + mem files in parallel).
      // We use a relative URL so it works regardless of where the page
      // is served from.
      const mod = await import('../vendor/webmscore/package/webmscore.local.mjs');
      window.WebMscore = mod.default;
      if (!window.WebMscore || typeof window.WebMscore.load !== 'function') {
        throw new Error('webmscore module loaded but does not expose .load()');
      }
      instance = window.WebMscore;
      return instance;
    })();
    try {
      return await initPromise;
    } finally {
      initPromise = null;  // allow retry after a failure
    }
  }

  // Attach to the existing MidiGraph namespace so app.js (which already
  // does `M = window.MidiGraph` at the top) can call it without any
  // extra wiring.
  if (typeof window !== 'undefined') {
    window.MidiGraph = window.MidiGraph || {};
    window.MidiGraph.convertMidiViaWebMscore = convertMidiViaWebMscore;
  }
})();