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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
