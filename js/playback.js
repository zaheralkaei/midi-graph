// playback.js — Tone.js playback for the parsed events, with active-note
// callbacks for graph highlighting.
//
// Public API:
//   MidiGraph.buildPlayback(events, ticksPerQuarter, callbacks) → { play, stop, noteCount }
//
//   events       : [{ timeTicks, type, note (cents), vel, track, channel, ... }, ...]
//   ticksPerQuarter : int
//   callbacks    (optional): { onNoteOn(cents, event), onNoteOff(cents, event) }
//
// Fixes vs. naive implementation:
//   - Stop button cancels scheduled-future notes too (not just releaseAll).
//   - Real note durations from matching note_off events.
//   - Multi-tempo via ticksToSecondsSegments.
//   - onNoteOn/onNoteOff fire at the exact scheduled audio time, not at the
//     wall-clock moment of scheduling. This keeps the visual glow in sync
//     with what the user hears even if the page is laggy.
//   - Each callback receives the original event object (2nd arg) so
//     callers can do track-aware filtering — e.g. when the user picks
//     a single track in the picker, only that track's notes glow on
//     the graph. See js/app.js for the filter wiring.
//
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
    //
    // We keep the original event reference on each note so the
    // onNoteOn/onNoteOff callbacks can access the track field (and
    // any other metadata). The notes array stores { startSec, durSec,
    // cents, event } — the event is passed through verbatim.
    const pending = new Map();   // cents → [{ tickOn, event }]  (FIFO queue)
    const notes = [];             // [{ startSec, durSec, cents, event }]
    for (const ev of events) {
      if (ev.type === 'on') {
        if (!pending.has(ev.note)) pending.set(ev.note, []);
        pending.get(ev.note).push({ tickOn: ev.timeTicks, event: ev });
      } else if (ev.type === 'off') {
        const stack = pending.get(ev.note);
        if (stack && stack.length) {
          const head = stack.shift();
          const startSec = tickToSec(head.tickOn);
          const endSec = tickToSec(ev.timeTicks);
          // The 0.05 lower bound ensures the synth has a non-zero
          // release time for very short notes (e.g. 16th notes at fast
          // tempos that round to < 50ms). The previous version also
          // capped durSec at 1.0s as a "safety net" but this caused
          // the graph glow to turn off mid-note for sustained sounds
          // (whole notes, pedal piano, organ chords, etc.) where the
          // OFF event is several seconds after the ON. The cap was
          // removed in favor of the isFinite check + lower bound only.
          let durSec = endSec - startSec;
          if (!isFinite(durSec) || durSec < 0.05) durSec = 0.05;
          notes.push({ startSec, durSec, cents: ev.note, event: head.event });
        }
        if (stack && stack.length === 0) pending.delete(ev.note);
      }
    }
    for (const [cents, stack] of pending) {
      for (const head of stack) {
        notes.push({ startSec: tickToSec(head.tickOn), durSec: 0.5, cents, event: head.event });
      }
    }
    notes.sort((a, b) => a.startSec - b.startSec);

    // Track scheduled events so stop() can cancel everything.
    let scheduledTimers = [];
    let playEndedTimer = null;
    let stopped = false;
    // Tracks which cents + track pairs are currently sounding (have had
    // their onNoteOn callback fire but not yet their onNoteOff). Used
    // by stop() to fire onNoteOff exactly once per active pitch,
    // avoiding over-decrement. Keyed by `${cents}|${track}` (not just
    // cents) so two tracks playing the same pitch simultaneously each
    // get their own independent onNoteOn / onNoteOff pair. Without
    // this, the FIRST track to release its note would delete the
    // shared key, and the SECOND track's release would skip its
    // onNoteOff — leaving the graph glow stuck ON for the duration
    // of the longer note even after the SELECTED track's note ended.
    let currentlyActive = new Set();

    function scheduleNote(n, startWallClock) {
      const cents = n.cents;
      const track = n.event && n.event.track != null ? n.event.track : -1;
      // Key includes track so simultaneous same-pitch notes from
      // different tracks each have their own onNoteOn/onNoteOff pair.
      const key = track < 0 ? cents : `${cents}|${track}`;
      const attackTime = startWallClock + n.startSec;
      const releaseTime = attackTime + n.durSec;
      const freq = 440 * Math.pow(2, (cents - 6900) / 1200);

      // Schedule the attack (the tone starts).
      const attackId = Tone.Draw.schedule(() => {
        if (stopped) return;
        synth.triggerAttack(freq, attackTime);
        currentlyActive.add(key);
        onNoteOn(cents, n.event);
      }, attackTime);

      // Schedule the release (the tone ends).
      const releaseId = Tone.Draw.schedule(() => {
        if (stopped) return;
        synth.triggerRelease(freq, releaseTime);
        if (currentlyActive.has(key)) {
          currentlyActive.delete(key);
          onNoteOff(cents, n.event);
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
          // Look up by the track-aware key (matching scheduleNote's logic).
          const lastNote = notes[notes.length - 1];
          const lastTrack = lastNote.event && lastNote.event.track != null ? lastNote.event.track : -1;
          const lastKey = lastTrack < 0 ? lastNote.cents : `${lastNote.cents}|${lastTrack}`;
          if (!stopped && currentlyActive.has(lastKey)) {
            currentlyActive.delete(lastKey);
            onNoteOff(lastNote.cents, lastNote.event);
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
      //
      // The stop() fallback doesn't have the original event object — we
      // only have the cents+track key. Extract the cents from the key
      // (which is either a number for untracked events, or a
      // "cents|track" string for tracked events). We pass null as the
      // event so the caller can detect the stop-time fallback and skip
      // track-aware filtering (treat the off as clearing any active
      // state regardless of track).
      for (const key of currentlyActive) {
        const cents = typeof key === 'string' ? parseInt(key.split('|')[0], 10) : key;
        onNoteOff(cents, null);
      }
      currentlyActive.clear();
    }

    return { play, stop, noteCount: notes.length, tickToSec };
  }

  M.buildPlayback = buildPlayback;
})();