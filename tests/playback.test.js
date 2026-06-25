// tests/playback.test.js — smoke tests for js/playback.js
//
// We mock the Tone.js globals so playback.js can load outside the
// browser. The tests focus on the callback API contract: each note
// event fires onNoteOn(cents, event) and onNoteOff(cents, event) with
// the original event object (which includes the `track` field for
// track-aware glow). See js/app.js for how the callback is wired.

const fs = require('fs');
const path = require('path');

// ---- Mock Tone.js ----
const scheduledCallbacks = [];
const cancelledIds = [];
// Pending setTimeout callbacks (we control when they fire, so the
// playEndedTimer fallback in js/playback.js is directly testable).
const pendingTimeouts = [];
let nowFn = () => 0;

global.Tone = {
  now: () => nowFn(),
  Draw: {
    schedule: (cb, time) => { scheduledCallbacks.push({ cb, time }); return scheduledCallbacks.length - 1; },
    cancel: (id) => { cancelledIds.push(id); },
  },
  PolySynth: function() {
    this.toDestination = () => this;
    this.triggerAttack = () => {};
    this.triggerRelease = () => {};
    this.releaseAll = () => {};
  },
  Synth: function() {},
};
// Override setTimeout so we can fire the playEndedTimer fallback
// synchronously in tests. The fallback is `setTimeout(fn, ms)` — we
// push the callback into pendingTimeouts and let the test fire it.
const realSetTimeout = setTimeout;
global.setTimeout = (fn, ms) => { pendingTimeouts.push({ fn, ms }); };

// playback.js expects window.MidiGraph to exist (it uses M.ticksToSecondsSegments).
// It also expects `window` to be the global object. We make `global === window`
// so playback.js's `const M = window.MidiGraph` resolves to global.MidiGraph.
global.window = global;
require('../js/midi.js');  // populates window.MidiGraph
require('../js/playback.js');

const M = global.MidiGraph;
let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; console.log('  ok    ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name); console.log('        ' + e.message); }
}
function assertEqual(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg ? msg + ': ' : '') + `expected ${B} got ${A}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

// ---- Tests ----

test('buildPlayback returns a tickToSec function (for chord-window scheduling)', () => {
  // Need a tempo event for ticksToSecondsSegments to compute a segment.
  // The MIDI parser sets a default tempo of 120 BPM on the first event.
  const events = [
    { type: 'on',  timeTicks: 0,   note: 6000, vel: 80, track: 1, tempoBPM: 120 },
    { type: 'off', timeTicks: 480, note: 6000, vel: 0,  track: 1, tempoBPM: 120 },
  ];
  const pb = M.buildPlayback(events, 480, {});
  assert(typeof pb.tickToSec === 'function', 'tickToSec should be a function');
  // At 120 BPM, 1 quarter (480 ticks) = 0.5 sec. 0 ticks → 0 sec.
  const sec0 = pb.tickToSec(0);
  const sec480 = pb.tickToSec(480);
  assert(Math.abs(sec0) < 0.001, `tick 0 should be 0s, got ${sec0}`);
  assert(Math.abs(sec480 - 0.5) < 0.001, `tick 480 should be 0.5s, got ${sec480}`);
});

test('buildPlayback passes the original event to onNoteOn (with track field)', () => {
  scheduledCallbacks.length = 0;
  const onCalls = [];
  const offCalls = [];
  const events = [
    { type: 'on',  timeTicks: 0,   note: 6000, vel: 80, track: 1, channel: 0 },
    { type: 'off', timeTicks: 480, note: 6000, vel: 0,  track: 1, channel: 0 },
  ];
  const pb = M.buildPlayback(events, 480, {
    onNoteOn:  (cents, ev) => onCalls.push({ cents, track: ev && ev.track, channel: ev && ev.channel }),
    onNoteOff: (cents, ev) => offCalls.push({ cents, track: ev && ev.track, channel: ev && ev.channel }),
  });
  // Call play() to schedule the note attacks and releases.
  pb.play();
  assertEqual(scheduledCallbacks.length, 2, 'should schedule attack + release');
  scheduledCallbacks[0].cb();   // attack
  scheduledCallbacks[1].cb();   // release
  assertEqual(onCalls, [{ cents: 6000, track: 1, channel: 0 }]);
  assertEqual(offCalls, [{ cents: 6000, track: 1, channel: 0 }]);
});

test('multi-track events keep their track identity through the callback', () => {
  scheduledCallbacks.length = 0;
  const onCalls = [];
  const events = [
    { type: 'on', timeTicks: 0, note: 6000, vel: 80, track: 1 },
    { type: 'on', timeTicks: 0, note: 6700, vel: 80, track: 2 },
    { type: 'off', timeTicks: 480, note: 6000, vel: 0, track: 1 },
    { type: 'off', timeTicks: 480, note: 6700, vel: 0, track: 2 },
  ];
  const pb = M.buildPlayback(events, 480, {
    onNoteOn: (cents, ev) => onCalls.push({ cents, track: ev && ev.track }),
  });
  pb.play();
  // Fire all scheduled callbacks.
  scheduledCallbacks.forEach((s) => s.cb());
  // onCalls should contain both notes with their track fields preserved.
  assertEqual(onCalls.length, 2, 'should fire onNoteOn twice');
  assertEqual(onCalls[0].cents, 6000);
  assertEqual(onCalls[0].track, 1);
  assertEqual(onCalls[1].cents, 6700);
  assertEqual(onCalls[1].track, 2);
});

test('stop() fires onNoteOff with null event (track-undefined for cleanup)', () => {
  scheduledCallbacks.length = 0;
  cancelledIds.length = 0;
  const offCalls = [];
  const events = [
    { type: 'on',  timeTicks: 0,   note: 6000, vel: 80, track: 1 },
    { type: 'off', timeTicks: 480, note: 6000, vel: 0,  track: 1 },
  ];
  const pb = M.buildPlayback(events, 480, {
    onNoteOff: (cents, ev) => offCalls.push({ cents, hasEvent: ev != null }),
  });
  pb.play();
  // Fire only the attack — note is still sounding when stop() runs.
  scheduledCallbacks[0].cb();
  pb.stop();
  // Stop's fallback should fire onNoteOff with the cents but no event.
  assertEqual(offCalls.length, 1, 'stop() should fire onNoteOff once');
  assertEqual(offCalls[0].cents, 6000);
  assertEqual(offCalls[0].hasEvent, false, 'stop() passes null event');
});

// Regression test: a previous bug scheduled the chord-glow Tone.Draw
// callbacks with relative seconds (tickToSec(startTick)) instead of
// wall-clock time. Tone.Draw fires "past time" callbacks immediately,
// so all the chord-glow callbacks ran in a chaotic burst at t=0.1s
// and the rest of the schedule was lost. The fix in js/app.js uses
// startWallClock = Tone.now() + 0.1 like playback.js does for the
// note attacks. This test pins the contract that callers should
// schedule Tone.Draw callbacks at FUTURE wall-clock times.
test('regression: scheduleNote uses Tone.now() + 0.1 base, not relative seconds', () => {
  // Sanity-check: the note attacks should be scheduled at
  // Tone.now() + 0.1 + n.startSec, not n.startSec.
  scheduledCallbacks.length = 0;
  const events = [
    { type: 'on',  timeTicks: 0,   note: 6000, vel: 80, track: 1, tempoBPM: 120 },
    { type: 'off', timeTicks: 480, note: 6000, vel: 0,  track: 1, tempoBPM: 120 },
  ];
  const pb = M.buildPlayback(events, 480, {});
  pb.play();
  // The note at tick 0 has startSec=0; if the bug existed, the
  // attack would be scheduled at time 0 (in the past). The fix
  // schedules at Tone.now() + 0.1 + 0 = ~0.1.
  assert(scheduledCallbacks.length >= 1, 'should schedule at least one attack');
  const attackTime = scheduledCallbacks[0].time;
  // Must be > 0 (future), not 0 (past). At Tone.now()=0 the attack
  // would be at 0.1.
  assert(attackTime > 0, `attack time should be in the future, got ${attackTime}`);
});

test('regression: sustained notes (> 1 second) keep the glow on for the full duration', () => {
  // Regression: the previous code capped durSec at 1.0s as a "safety
  // net" against runaway durations, but this caused the graph glow
  // to turn off mid-note for sustained sounds (whole notes, pedal
  // piano, organ chords, slow melodic pieces) where the OFF event
  // is several seconds after the ON. The cap was removed; durSec
  // now reflects the actual time between ON and OFF.
  scheduledCallbacks.length = 0;
  // 2-second note at 60bpm: on at tick 0, off at tick 1920 (1920
  // ticks at 960 tpq = 2 quarters = 2 seconds at 60bpm).
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80, track: 1, tempoBPM: 60 },
    { type: 'off', timeTicks: 1920, note: 6000, vel: 0,  track: 1, tempoBPM: 60 },
  ];
  const pb = M.buildPlayback(events, 960, {});
  pb.play();
  // Find the attack (on) and release (off) for this note.
  // scheduledCallbacks is appended in the order: attack0, release0, attack1, release1, ...
  assert(scheduledCallbacks.length === 2, `expected 2 callbacks (attack + release), got ${scheduledCallbacks.length}`);
  const attack = scheduledCallbacks[0];
  const release = scheduledCallbacks[1];
  const attackTime = attack.time;
  const releaseTime = release.time;
  const glowDuration = releaseTime - attackTime;
  // Should be 2.0s, not capped to 1.0s.
  assert(Math.abs(glowDuration - 2.0) < 0.01,
    `glow duration should be 2.0s for a 2-second note, got ${glowDuration}s`);
});

test('regression: same-pitch notes from different tracks each fire onNoteOff independently', () => {
  // Regression: the previous code keyed the `currentlyActive` Set by
  // cents only, so when two tracks played the same pitch simultaneously
  // and the FIRST track's release fired, it deleted the shared key
  // and the SECOND track's release was skipped — its onNoteOff never
  // fired, leaving the graph glow stuck ON for the duration of the
  // longer note even after the SELECTED track's note had ended.
  //
  // The fix: key currentlyActive by `${cents}|${track}` so each
  // track+cent pair has its own independent lifecycle.
  scheduledCallbacks.length = 0;
  cancelledIds.length = 0;
  const offCalls = [];
  // Track 1 plays C4 briefly (480 ticks), Track 2 plays C4 longer
  // (1920 ticks). Both at tpq=480, so 1 quarter per 480 ticks.
  // At 120bpm: 1 second per quarter. Track 1 = 0.5s, Track 2 = 2s.
  const events = [
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80, track: 1 },
    { type: 'off', timeTicks: 480,  note: 6000, vel: 0,  track: 1 },
    { type: 'on',  timeTicks: 0,    note: 6000, vel: 80, track: 2 },
    { type: 'off', timeTicks: 1920, note: 6000, vel: 0,  track: 2 },
  ];
  const pb = M.buildPlayback(events, 480, {
    onNoteOff: (cents, ev) => offCalls.push({ cents, track: ev && ev.track }),
  });
  pb.play();
  // Fire all 4 scheduled callbacks (2 attacks, 2 releases) in order.
  // Tone.Draw is mocked to push in order; release 1 fires at 0.5s,
  // release 2 fires at 2.0s.
  for (const sc of scheduledCallbacks) sc.cb();
  // Both releases should have fired onNoteOff. The previous bug skipped
  // the second release because the first release deleted the shared
  // cents key from currentlyActive.
  assertEqual(offCalls.length, 2,
    `expected 2 onNoteOff calls (one per track), got ${offCalls.length}`);
  assertEqual(offCalls[0].cents, 6000, 'first off should be for cents 6000');
  assertEqual(offCalls[0].track, 1, 'first off should be for track 1');
  assertEqual(offCalls[1].cents, 6000, 'second off should be for cents 6000');
  assertEqual(offCalls[1].track, 2, 'second off should be for track 2 (this was previously dropped)');
});

test('regression: playEndedTimer fallback fires onNoteOff for the SELECTED track, not just the last note by startSec', () => {
  // Regression: when a piece has multiple tracks, the "last note by
  // startSec" might be from a track the user is NOT viewing (e.g.
  // the bass plays the very last note of the file). The previous
  // code's playEndedTimer only handled `notes[notes.length - 1]`,
  // and the app.js track filter rejected that note's onNoteOff
  // (because event.track !== sel). The actual LAST NOTE of the
  // SELECTED track would then be left with no fallback if its
  // Tone.Draw release happened to be missed — leaving the graph
  // glow stuck ON for the selected track's final note.
  //
  // The fix: iterate ALL notes that are still in currentlyActive
  // at play-end and fire onNoteOff for each, looking up the original
  // event from the `notes` array (so the track filter in app.js can
  // correctly let the selected track through and reject others).
  scheduledCallbacks.length = 0;
  cancelledIds.length = 0;
  pendingTimeouts.length = 0;
  const offCalls = [];
  // Track 0 (selected by app.js) ends its LAST NOTE at tick 480.
  // Track 1 (not selected) ends its LAST NOTE at tick 960 — later.
  // The "last note by startSec" is from track 1, not track 0.
  const events = [
    { type: 'on',  timeTicks: 240, note: 6000, vel: 80, track: 0 },
    { type: 'off', timeTicks: 480, note: 6000, vel: 0,  track: 0 },
    { type: 'on',  timeTicks: 480, note: 4000, vel: 80, track: 1 },
    { type: 'off', timeTicks: 960, note: 4000, vel: 0,  track: 1 },
  ];
  const pb = M.buildPlayback(events, 480, {
    onNoteOff: (cents, ev) => offCalls.push({ cents, track: ev && ev.track }),
  });
  pb.play();
  // Simulate Tone.Draw MISSING all releases. We fire only the
  // attack callbacks (so currentlyActive has both keys), but not
  // the release callbacks (so the fallback has to handle them).
  // scheduledCallbacks is appended in order: attack0, release0,
  // attack1, release1, then setTimeout for playEndedTimer.
  assertEqual(scheduledCallbacks.length, 4, 'expected 4 Draw callbacks');
  scheduledCallbacks[0].cb();  // attack for track 0
  scheduledCallbacks[2].cb();  // attack for track 1
  // pendingTimeouts has the playEndedTimer fallback.
  assertEqual(pendingTimeouts.length, 1, 'expected 1 pending setTimeout');
  // Now fire the fallback. It should fire onNoteOff for BOTH active
  // notes (track 0's cents 6000 and track 1's cents 4000). The app.js
  // track filter would then let track 0 through and reject track 1,
  // but the playback's job is to fire onNoteOff for every active note.
  pendingTimeouts[0].fn();
  assertEqual(offCalls.length, 2,
    `fallback should fire onNoteOff for both active notes, got ${offCalls.length}`);
  // The order is undefined (we iterate currentlyActive which is a Set
  // in Node.js — order is insertion order). Check that BOTH tracks
  // got an onNoteOff call.
  const tracks = offCalls.map(c => c.track).sort();
  assertEqual(tracks, [0, 1],
    `expected onNoteOff for both tracks 0 and 1, got ${JSON.stringify(tracks)}`);
  // Critically: track 0 (the SELECTED track) must be in the list.
  // Before the fix, only the last note by startSec (track 1) would
  // get an onNoteOff — and the track filter in app.js would reject
  // it. Track 0's note would be left with no onNoteOff at all.
  assert(offCalls.some(c => c.track === 0 && c.cents === 6000),
    'fallback must fire onNoteOff for the selected track (track 0, cents 6000)');
});

test('regression: polyphonic steal force-releases a previous note when its Tone.Draw release was missed', () => {
  // Regression: in long pieces (e.g. the user's ya-tyra_with_h
  // 79-second file), Tone.Draw's internal queue can drop late
  // release callbacks. The activeCount in the graph then never
  // decrements, and the glow stays ON for the rest of the
  // playback.
  //
  // The fix: when an attack fires for a key that's still in
  // currentlyActive, the previous note's release was almost
  // certainly missed. Force the previous note's off callback
  // NOW (before the new attack increments the count), so the
  // activeCount returns to 0 before the new note starts.
  scheduledCallbacks.length = 0;
  cancelledIds.length = 0;
  pendingTimeouts.length = 0;
  const onCalls = [];
  const offCalls = [];
  // Two consecutive C4 notes on track 0, re-articulated.
  // Note A: 0-480 ticks (0.5s). Note B: 480-960 ticks (0.5s).
  // We skip Note A's release to simulate Tone.Draw dropping it.
  const events = [
    { type: 'on',  timeTicks: 0,   note: 6000, vel: 80, track: 0 },
    { type: 'off', timeTicks: 480, note: 6000, vel: 0,  track: 0 },
    { type: 'on',  timeTicks: 480, note: 6000, vel: 80, track: 0 },
    { type: 'off', timeTicks: 960, note: 6000, vel: 0,  track: 0 },
  ];
  const pb = M.buildPlayback(events, 480, {
    onNoteOn: (cents, ev) => onCalls.push({ cents, track: ev && ev.track }),
    onNoteOff: (cents, ev) => offCalls.push({ cents, track: ev && ev.track }),
  });
  pb.play();
  // scheduledCallbacks: attack0, release0, attack1, release1
  assertEqual(scheduledCallbacks.length, 4, 'expected 4 Draw callbacks');
  // Fire attack0 (Note A starts). currentlyActive gets '6000|0'.
  scheduledCallbacks[0].cb();
  assertEqual(onCalls.length, 1, 'note A on should have fired');
  // Skip release0 (simulate Tone.Draw dropping it).
  // Fire attack1 (Note B starts). The polyphonic steal should
  // detect that '6000|0' is still active and force-release Note A.
  scheduledCallbacks[2].cb();
  // After Note B's attack: the steal fires onNoteOff for Note A
  // BEFORE the new onNoteOn. So offCalls has 1 entry, onCalls has 2.
  assertEqual(offCalls.length, 1,
    `polyphonic steal should fire 1 off call (for stale Note A), got ${offCalls.length}`);
  assertEqual(offCalls[0].track, 0, 'steal off should be for track 0');
  assertEqual(onCalls.length, 2, 'both on calls should have fired');
  // The track filter in app.js would let track 0's off through
  // and decrement activeCount. Then the new attack increments.
  // Net effect: count goes 0 → 1 (Note A) → 0 (steal) → 1 (Note B).
  // The glow is ON for Note A's duration, OFF briefly during the
  // steal (in the same JS frame), then ON for Note B's duration.
  // Then Note B's release fires normally:
  scheduledCallbacks[3].cb();
  assertEqual(offCalls.length, 2,
    `Note B release should fire normally, got ${offCalls.length} off calls`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
