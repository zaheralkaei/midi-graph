// sheet.js — render MusicXML as sheet music using OSMD.
//
// OSMD (OpenSheetMusicDisplay) is loaded from a CDN <script> tag in index.html
// as the global `opensheetmusicdisplay`. We instantiate it on first MusicXML
// load and reuse it for subsequent files.
//
// Public API:
//   MidiGraph.renderSheet(containerEl, xmlText) → Promise<void>
//       Renders the MusicXML inside the container. If a previous render exists,
//       it's cleared first.
//
//   MidiGraph.clearSheet() → void
//       Removes any rendered sheet music.
//
//   MidiGraph.isSheetAvailable() → boolean
//       True if OSMD loaded successfully. False if the CDN script failed.

(function () {
  const M = window.MidiGraph;
  let osmdInstance = null;
  let currentContainer = null;

  function isSheetAvailable() {
    return typeof window.opensheetmusicdisplay !== 'undefined';
  }

  function clearSheet() {
    if (currentContainer) {
      currentContainer.innerHTML = '';
    }
    osmdInstance = null;
  }

  async function renderSheet(container, xmlText) {
    if (!isSheetAvailable()) {
      container.innerHTML = '<p style="color: var(--muted);">Sheet music renderer (OSMD) failed to load from CDN. Check your network connection.</p>';
      return;
    }
    // OSMD wants a clean container for each render. Clear, then re-init.
    container.innerHTML = '';
    currentContainer = container;
    try {
      osmdInstance = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(container, {
        autoResize: true,
        backend: 'svg',
        drawTitle: true,
        drawComposer: true,
        drawingParameters: 'default',
      });
      await osmdInstance.load(xmlText);
      osmdInstance.render();
    } catch (e) {
      container.innerHTML = `<p style="color: #ff5252;">Failed to render sheet music: ${e.message}</p>`;
      osmdInstance = null;
    }
  }

  M.renderSheet = renderSheet;
  M.clearSheet = clearSheet;
  M.isSheetAvailable = isSheetAvailable;
})();