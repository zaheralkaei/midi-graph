// playback.js — Tone.js playback for the parsed events, with active-note
// callbacks for graph highlighting.
//
// Public API:
//   MidiGraph.buildPlayback(events, ticksPerQuarter, callbacks) → { play, stop, noteCount }
//
//   events       : [{ timeTicks, type, note (cents), tempoBPM }, ...]
//   ticksPerQuarter : int
//   callbacks    (optional): { onNoteOn(cents), onNoteOff(cents) }
//
// Fixes vs. naive implementation:
//   - Stop button cancels scheduled-future notes too (not just releaseAll).
//   - Real note durations from matching note_off events.
//   - Multi-tempo via ticksToSecondsSegments.
//   - onNoteOn/onNoteOff fire at the exact scheduled audio time, not at the
//     wall-clock moment of scheduling. This keeps the visual glow in sync
//     with what the user hears even if the page is laggy.

(function () {
  const M = window.MidiGraph;

  function buildPlayback(events, ticksPerQuarter, callbacks) {
    const tickToSec = M.ticksToSecondsSegments(events, ticksPerQuarter);
    const synth = new Tone.PolySynth(Tone.Synth).toDestination();
    const cb = callbacks || {};
    const onNoteOn = cb.onNoteOn || (() => {});
    const onNoteOff = cb.onNoteOff || (() => {});

    // Build per-note durations: pair each on with its matching off.
    const pending = new Map();   // cents → [tickOn]
    const notes = [];             // [{ startSec, durSec, cents }]
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
          notes.push({ startSec, durSec, cents: ev.note });
          pending.delete(ev.note);
        }
      }
    }
    for (const [cents, [tOn]] of pending) {
      notes.push({ startSec: tickToSec(tOn), durSec: 0.5, cents });
    }
    notes.sort((a, b) => a.startSec - b.startSec);

    // Track scheduled events so stop() can cancel everything.
    let scheduledTimers = [];
    let playEndedTimer = null;
    let stopped = false;

    function scheduleNote(n, startWallClock) {
      const cents = n.cents;
      const attackTime = startWallClock + n.startSec;
      const releaseTime = attackTime + n.durSec;
      const freq = 440 * Math.pow(2, (cents - 6900) / 1200);

      // Schedule the attack (the tone starts).
      const attackId = Tone.Draw.schedule(() => {
        if (stopped) return;
        synth.triggerAttack(freq, attackTime);
        onNoteOn(cents);
      }, attackTime);

      // Schedule the release (the tone ends).
      const releaseId = Tone.Draw.schedule(() => {
        if (stopped) return;
        synth.triggerRelease(freq, releaseTime);
        onNoteOff(cents);
      }, releaseTime);

      scheduledTimers.push(attackId, releaseId);
    }

    function play() {
      return new Promise((resolve) => {
        if (!notes.length || stopped) {
          resolve(0);
          return;
        }
        stopped = false;
        const startWallClock = Tone.now() + 0.1;

        for (const n of notes) {
          scheduleNote(n, startWallClock);
        }

        const totalSec = notes[notes.length - 1].startSec +
                         notes[notes.length - 1].durSec + 0.5;
        playEndedTimer = setTimeout(() => {
          // Make sure the last note's off callback fires if Draw missed it.
          if (!stopped) onNoteOff(notes[notes.length - 1].cents);
          resolve(totalSec);
        }, totalSec * 1000);
      });
    }

    function stop() {
      stopped = true;
      // Cancel all scheduled Tone.Draw callbacks so future notes never fire.
      for (const id of scheduledTimers) {
        Tone.Draw.cancel(id);
      }
      scheduledTimers = [];
      if (playEndedTimer) {
        clearTimeout(playEndedTimer);
        playEndedTimer = null;
      }
      // Kill any currently-sounding voices.
      synth.releaseAll();
      // Tell the graph to drop the glow on every active note.
      for (const n of notes) {
        onNoteOff(n.cents);
      }
    }

    return { play, stop, noteCount: notes.length };
  }

  M.buildPlayback = buildPlayback;
})();