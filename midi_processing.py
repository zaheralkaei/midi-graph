import mido
from collections import defaultdict, Counter
import networkx as nx
import json
import random

# Helper function to convert MIDI note number to pitch name
def midi_to_pitch(note):
    note_names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
    octave = (note // 12) - 1
    note_name = note_names[note % 12]
    return f"{note_name}{octave}"

# Read a MIDI file and extract note-on messages with positive velocity
def read_midi_file(file_path):
    midi = mido.MidiFile(file_path)
    notes = []
    
    for track in midi.tracks:
        for msg in track:
            if msg.type == 'note_on' and msg.velocity > 0:
                notes.append(msg.note)
    
    return notes

# Calculate transition probabilities between notes
def calculate_transition_probabilities(notes):
    transitions = defaultdict(Counter)
    total_transitions = defaultdict(int)

    for i in range(len(notes) - 1):
        current_note = notes[i]
        next_note = notes[i + 1]
        transitions[current_note][next_note] += 1
        total_transitions[current_note] += 1

    transition_probabilities = {}
    for current_note, counter in transitions.items():
        transition_probabilities[current_note] = {note: count / total_transitions[current_note] for note, count in counter.items()}
    
    return transition_probabilities

# Generate graph data for d3.js
def generate_graph_data(transition_probabilities):
    nodes = set()
    links = []

    for current_note, transitions in transition_probabilities.items():
        current_note_name = midi_to_pitch(current_note)
        nodes.add(current_note_name)
        for next_note, prob in transitions.items():
            next_note_name = midi_to_pitch(next_note)
            nodes.add(next_note_name)
            links.append({
                'source': current_note_name,
                'target': next_note_name,
                'value': prob
            })

    node_list = [{'id': node} for node in nodes]
    graph_data = {
        'nodes': node_list,
        'links': links
    }
    return graph_data

# Save graph data to a JSON file
def save_graph_data(transition_probabilities, output_path):
    graph_data = generate_graph_data(transition_probabilities)
    with open(output_path, 'w') as f:
        json.dump(graph_data, f)
