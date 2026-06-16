"""midi-graph: Flask server.

Upload a .mid file → server parses it, builds a note→next-note transition
graph, computes summary stats, and serves both. The browser renders the
graph with D3 and plays the MIDI back with Tone.js.

Run:
    pip install -r requirements.txt
    python app.py
Then open http://localhost:5000
"""

import os

from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)
from werkzeug.utils import secure_filename

from midi_processing import analyze_midi


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

UPLOAD_FOLDER = 'uploads'
DATA_FOLDER = 'data'
ALLOWED_EXTENSIONS = {'mid', 'midi'}
MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB cap on uploads — refuse anything bigger

app = Flask(__name__, static_folder='static', template_folder='templates')
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['DATA_FOLDER'] = DATA_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# Make sure runtime directories exist. data/ is where the generated graph JSONs
# live; uploads/ holds the original .mid files the browser may play back.
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(DATA_FOLDER, exist_ok=True)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _allowed_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route('/', methods=['GET', 'POST'])
def upload_file():
    if request.method == 'POST':
        if 'file' not in request.files:
            return redirect(request.url)
        f = request.files['file']
        if f.filename == '':
            return redirect(request.url)
        if not (f and _allowed_file(f.filename)):
            return redirect(request.url)

        filename = secure_filename(f.filename)
        upload_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        f.save(upload_path)

        # Build the graph + stats. analyze_midi does parse → graph → stats in one call.
        graph, stats = analyze_midi(upload_path)

        # Persist the graph JSON for the browser to fetch. Stats are passed
        # inline (smaller, no need for a second fetch).
        json_filename = f"{filename}.json"
        with open(os.path.join(app.config['DATA_FOLDER'], json_filename), 'w') as out:
            import json
            json.dump(graph, out)

        return redirect(url_for('show_graph', filename=filename))

    return render_template('upload.html')


@app.route('/graph/<filename>')
def show_graph(filename):
    """Render the analyzed view for an already-uploaded file."""
    safe = secure_filename(filename)
    json_filename = f"{safe}.json"

    # The graph is already on disk from the upload step, but we need the
    # matching stats for the stats panel. Recompute them — fast for files
    # under the 16 MB cap, and we don't have a stats file persisted.
    upload_path = os.path.join(app.config['UPLOAD_FOLDER'], safe)
    if not os.path.exists(upload_path):
        abort(404)
    _, stats = analyze_midi(upload_path)

    return render_template(
        'upload.html',
        filename=safe,
        json_filename=json_filename,
        stats=stats,
    )


@app.route('/data/<filename>')
def data_file(filename):
    return send_from_directory(os.path.abspath(app.config['DATA_FOLDER']), secure_filename(filename))


@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(os.path.abspath(app.config['UPLOAD_FOLDER']), secure_filename(filename))


# ---------------------------------------------------------------------------
# Error handler
# ---------------------------------------------------------------------------

@app.errorhandler(413)
def file_too_large(_e):
    # 16 MB cap hit. Tell the browser to show a sensible message.
    return jsonify({'error': 'File too large. Limit is 16 MB.'}), 413


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    app.run(debug=True)
