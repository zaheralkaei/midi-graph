"""MIDI file → note transition graph.

Reads a .mid file, builds a Markov-style transition graph of note → next note,
and emits both a D3-friendly JSON representation and a stats summary that the
UI can show alongside the graph.
"""

from collections import Counter, defaultdict
import json

import mido


# ---------------------------------------------------------------------------
# Pitch conversion
# ---------------------------------------------------------------------------

_NOTE_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']


def midi_to_pitch(note_number: int) -> str:
    """Convert a MIDI note number (0-127) to scientific pitch notation (e.g. 60 -> C4)."""
    octave = (note_number // 12) - 1
    return f"{_NOTE_NAMES[note_number % 12]}{octave}"


def pitch_class(note_number: int) -> str:
    """Pitch class only, without octave: 60 -> C, 61 -> Db, etc. Used for TIER 3 color coding."""
    return _NOTE_NAMES[note_number % 12]


# ---------------------------------------------------------------------------
# MIDI parsing
# ---------------------------------------------------------------------------

def read_midi_file(file_path: str) -> list[int]:
    """Return a flat list of note numbers from a MIDI file, in playback order.

    Walks every track, collects note_on messages with positive velocity (the
    conventional way to extract the notes that were actually struck). Time is
    NOT preserved — we want the *sequence* of notes, not the absolute timing,
    because the transition graph only cares about "what note came next".
    """
    mid = mido.MidiFile(file_path)
    notes: list[int] = []
    for track in mid.tracks:
        for msg in track:
            if msg.type == 'note_on' and msg.velocity > 0:
                notes.append(msg.note)
    return notes


# ---------------------------------------------------------------------------
# Transition graph
# ---------------------------------------------------------------------------

def calculate_transition_probabilities(notes: list[int]) -> dict[int, dict[int, float]]:
    """Build a {current_note: {next_note: probability}} map from a note sequence."""
    transitions: dict[int, Counter] = defaultdict(Counter)
    totals: dict[int, int] = defaultdict(int)

    for i in range(len(notes) - 1):
        cur, nxt = notes[i], notes[i + 1]
        transitions[cur][nxt] += 1
        totals[cur] += 1

    return {
        cur: {nxt: count / totals[cur] for nxt, count in counter.items()}
        for cur, counter in transitions.items()
    }


def generate_graph_data(transition_probabilities: dict[int, dict[int, float]]) -> dict:
    """Convert raw {int: {int: float}} transitions to D3-friendly nodes/links.

    Node IDs are scientific pitch names (e.g. "C4"), so the D3 labels read
    naturally. Links carry the probability as `value` for the UI to render
    thickness / labels.
    """
    nodes: set[str] = set()
    links: list[dict] = []

    for cur, transitions in transition_probabilities.items():
        cur_name = midi_to_pitch(cur)
        nodes.add(cur_name)
        for nxt, prob in transitions.items():
            nxt_name = midi_to_pitch(nxt)
            nodes.add(nxt_name)
            links.append({
                'source': cur_name,
                'target': nxt_name,
                'value': prob,
            })

    return {
        'nodes': [{'id': n} for n in sorted(nodes)],
        'links': links,
    }


def save_graph_data(transition_probabilities: dict[int, dict[int, float]], output_path: str) -> dict:
    """Build the graph JSON and write it to disk. Returns the dict for convenience."""
    graph = generate_graph_data(transition_probabilities)
    with open(output_path, 'w') as f:
        json.dump(graph, f)
    return graph


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def compute_stats(notes: list[int], transition_probabilities: dict[int, dict[int, float]]) -> dict:
    """Summary numbers that the UI shows in the stats panel.

    All numbers come from the same `notes` list the graph is built from, so
    they always agree with what the graph is showing.
    """
    unique_notes = sorted(set(notes))
    pitch_names = [midi_to_pitch(n) for n in unique_notes]

    # Flatten the transitions into a single ranked list of (cur, nxt, prob).
    ranked: list[tuple[str, str, float]] = []
    for cur, transitions in transition_probabilities.items():
        cur_name = midi_to_pitch(cur)
        for nxt, prob in transitions.items():
            nxt_name = midi_to_pitch(nxt)
            ranked.append((cur_name, nxt_name, prob))
    ranked.sort(key=lambda x: -x[2])

    # Self-loops: same note → same note
    self_loops = sum(1 for cur, nxt, _ in ranked if cur == nxt)
    self_loop_share = self_loops / len(ranked) if ranked else 0.0

    # Pitch range
    if unique_notes:
        lowest = min(unique_notes)
        highest = max(unique_notes)
        range_str = f"{midi_to_pitch(lowest)} – {midi_to_pitch(highest)} ({highest - lowest} semitones)"
    else:
        range_str = "—"

    return {
        'note_count': len(notes),
        'unique_note_count': len(unique_notes),
        'unique_notes': pitch_names,
        'transition_count': len(ranked),
        'top_transitions': [
            {'from': cur, 'to': nxt, 'probability': round(prob, 4)}
            for cur, nxt, prob in ranked[:5]
        ],
        'self_loop_count': self_loops,
        'self_loop_share': round(self_loop_share, 4),
        'pitch_range': range_str,
    }


# ---------------------------------------------------------------------------
# All-in-one
# ---------------------------------------------------------------------------

def analyze_midi(file_path: str) -> tuple[dict, dict]:
    """Convenience: parse → graph + stats. Returns (graph_dict, stats_dict)."""
    notes = read_midi_file(file_path)
    transitions = calculate_transition_probabilities(notes)
    graph = generate_graph_data(transitions)
    stats = compute_stats(notes, transitions)
    return graph, stats
