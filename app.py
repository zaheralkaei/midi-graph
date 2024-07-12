from flask import Flask, request, redirect, url_for, render_template, send_from_directory
import os
from werkzeug.utils import secure_filename
from midi_processing import read_midi_file, calculate_transition_probabilities, save_graph_data

UPLOAD_FOLDER = 'uploads'
DATA_FOLDER = 'data'
ALLOWED_EXTENSIONS = {'mid', 'midi'}

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['DATA_FOLDER'] = DATA_FOLDER

# Ensure upload and data directories exist
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(DATA_FOLDER, exist_ok=True)

# Check if the uploaded file is allowed
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/', methods=['GET', 'POST'])
def upload_file():
    if request.method == 'POST':
        if 'file' not in request.files:
            return redirect(request.url)
        file = request.files['file']
        if file.filename == '':
            return redirect(request.url)
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(filepath)
            
            # Process the MIDI file
            notes = read_midi_file(filepath)
            transition_probabilities = calculate_transition_probabilities(notes)
            output_data_path = os.path.join(app.config['DATA_FOLDER'], f"{filename}.json")
            save_graph_data(transition_probabilities, output_data_path)
            
            return redirect(url_for('show_graph', filename=filename))
    return render_template('upload.html')

@app.route('/graph/<filename>')
def show_graph(filename):
    json_filename = f"{filename}.json"
    return render_template('upload.html', filename=filename, json_filename=json_filename)

@app.route('/data/<filename>')
def data_file(filename):
    return send_from_directory(app.config['DATA_FOLDER'], filename)

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

if __name__ == '__main__':
    app.run(debug=True)
