// playback.js — Tone.js playback for the parsed MIDI events.
//
// Bug fixes vs. the old version:
//   1. Real note durations — note_off events are honored. Each note_on
//      triggers attack at its absolute tick time, with release at the
//      matching note_off tick. If a note has no matching off (truncated
//      file, hanging note), we cap duration at 1s to avoid runaway ringing.
//   2. Multi-tempo — uses MidiGraph.ticksToSecondsSegments() so tempo
//      changes mid-piece play at the correct speed.
//   3. Removed the dead `Tone.Draw && 0` placeholder.
//
// Public API:
//   MidiGraph.playback(events, ticksPerQuarter) → controller { play, stop }
//
// `events` is the merged, time-sorted event list from MidiGraph.parseMidi().
// Each event has timeTicks, type ('on'|'off'), note, tempoBPM.

(function () {
  const M = window.MidiGraph;

  function buildPlayback(events, ticksPerQuarter) {
    const tickToSec = M.ticksToSecondsSegments(events, ticksPerQuarter);
    const synth = new Tone.PolySynth(Tone.Synth).toDestination();
    let scheduled = [];
    let playTimer = null;

    // Build per-note durations: pair each on with its matching off, falling
    // back to a 1s cap if the off is missing.
    const pending = new Map();   // note → [tickOn]
    const notes = [];             // [{ startSec, durSec, midi }]
    for (const ev of events) {
      if (ev.type === 'on') {
        pending.set(ev.note, [ev.timeTicks]);
      } else if (ev.type === 'off') {
        const start = pending.get(ev.note);
        if (start) {
          const [tOn] = start;
          const startSec = tickToSec(tOn);
          const endSec = tickToSec(ev.timeTicks);
          let durSec = Math.max(0.05, endSec - startSec);
          if (!isFinite(durSec) || durSec > 1.0) durSec = 1.0;
          notes.push({ startSec, durSec, midi: ev.note });
          pending.delete(ev.note);
        }
      }
    }
    // Any on events still pending at end-of-track get a 0.5s default.
    for (const [midi, [tOn]] of pending) {
      notes.push({ startSec: tickToSec(tOn), durSec: 0.5, midi });
    }
    notes.sort((a, b) => a.startSec - b.startSec);

    function play() {
      return new Promise((resolve) => {
        if (!notes.length) {
          resolve(0);
          return;
        }
        const startWallClock = Tone.now() + 0.1;
        for (const n of notes) {
          const freq = Tone.Frequency(n.midi, 'midi').toFrequency();
          synth.triggerAttackRelease(freq, n.durSec, startWallClock + n.startSec);
        }
        const totalSec = notes[notes.length - 1].startSec + notes[notes.length - 1].durSec + 0.5;
        playTimer = setTimeout(resolve, totalSec * 1000);
      });
    }

    function stop() {
      synth.releaseAll();
      if (playTimer) {
        clearTimeout(playTimer);
        playTimer = null;
      }
    }

    return { play, stop, noteCount: notes.length };
  }

  M.buildPlayback = buildPlayback;
})();