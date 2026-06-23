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
    // Use a FIFO queue of pending onsets per pitch. The OFF closes
    // the OLDEST pending ON, which avoids 1-tick ghost notes on the
    // "sustained + re-articulate" pattern (ON1, ON2 same tick, OFF
    // same tick: shift() closes ON1, pop() would close ON2 with dur=0).
    // For polyphonic chords (different pitches) FIFO and LIFO are
    // equivalent since each pitch has its own queue.
    const pending = new Map();   // cents → tickOn[]  (FIFO queue)
    const notes = [];             // [{ startSec, durSec, cents }]
    for (const ev of events) {
      if (ev.type === 'on') {
        if (!pending.has(ev.note)) pending.set(ev.note, []);
        pending.get(ev.note).push(ev.timeTicks);
      } else if (ev.type === 'off') {
        const stack = pending.get(ev.note);
        if (stack && stack.length) {
          const tOn = stack.shift();
          const startSec = tickToSec(tOn);
          const endSec = tickToSec(ev.timeTicks);
          let durSec = Math.max(0.05, endSec - startSec);
          if (!isFinite(durSec) || durSec > 1.0) durSec = 1.0;
          notes.push({ startSec, durSec, cents: ev.note });
        }
        if (stack && stack.length === 0) pending.delete(ev.note);
      }
    }
    for (const [cents, stack] of pending) {
      for (const tOn of stack) {
        notes.push({ startSec: tickToSec(tOn), durSec: 0.5, cents });
      }
    }
    notes.sort((a, b) => a.startSec - b.startSec);

    // Track scheduled events so stop() can cancel everything.
    let scheduledTimers = [];
    let playEndedTimer = null;
    let stopped = false;
    // Tracks which cents are currently sounding (have had their onNoteOn
    // callback fire but not yet their onNoteOff). Used by stop() to fire
    // onNoteOff exactly once per active pitch, avoiding over-decrement.
    let currentlyActive = new Set();

    function scheduleNote(n, startWallClock) {
      const cents = n.cents;
      const attackTime = startWallClock + n.startSec;
      const releaseTime = attackTime + n.durSec;
      const freq = 440 * Math.pow(2, (cents - 6900) / 1200);

      // Schedule the attack (the tone starts).
      const attackId = Tone.Draw.schedule(() => {
        if (stopped) return;
        synth.triggerAttack(freq, attackTime);
        currentlyActive.add(cents);
        onNoteOn(cents);
      }, attackTime);

      // Schedule the release (the tone ends).
      const releaseId = Tone.Draw.schedule(() => {
        if (stopped) return;
        synth.triggerRelease(freq, releaseTime);
        if (currentlyActive.has(cents)) {
          currentlyActive.delete(cents);
          onNoteOff(cents);
        }
      }, releaseTime);

      scheduledTimers.push(attackId, releaseId);
    }

    function play() {
      return new Promise((resolve) => {
        // Reset stopped FIRST, before the guard. Otherwise: after a Stop,
        // stopped stays true forever and every subsequent play() bails at
        // line `if (... || stopped)`. The reset has to happen before the
        // bail check so a Stop→Play sequence works.
        stopped = false;
        if (!notes.length || scheduledTimers.length > 0) {
          // Bail cases:
          //   - no notes in this playback instance (shouldn't happen)
          //   - previous play() is still in flight (double-play guard;
          //     outer app.js already disables the Play button, but
          //     Tone.start() is async and can race)
          resolve(0);
          return;
        }
        const startWallClock = Tone.now() + 0.1;

        for (const n of notes) {
          scheduleNote(n, startWallClock);
        }

        const totalSec = notes[notes.length - 1].startSec +
                         notes[notes.length - 1].durSec + 0.5;
        playEndedTimer = setTimeout(() => {
          // Make sure the last note's off callback fires if Draw missed it.
          if (!stopped && currentlyActive.has(notes[notes.length - 1].cents)) {
            currentlyActive.delete(notes[notes.length - 1].cents);
            onNoteOff(notes[notes.length - 1].cents);
          }
          // Clear scheduled timer ids now that the play has fully completed.
          // Without this, a second call to play() would see scheduledTimers
          // non-empty and bail out at the double-play guard, leaving the user
          // unable to replay the same file. (stop() already clears them on
          // explicit user cancellation.)
          scheduledTimers = [];
          playEndedTimer = null;
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
      // Fire onNoteOff exactly once per currently-active pitch. This avoids
      // the over-decrement bug where calling onNoteOff for every scheduled
      // note (including ones that already released normally) would decrement
      // the graph's activeCount past zero.
      for (const cents of currentlyActive) {
        onNoteOff(cents);
      }
      currentlyActive.clear();
    }

    return { play, stop, noteCount: notes.length };
  }

  M.buildPlayback = buildPlayback;
})();