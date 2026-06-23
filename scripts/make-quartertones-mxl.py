"""Create examples/quartertones.mxl by zipping examples/quartertones.musicxml.

A .mxl file is just a ZIP archive containing:
  - META-INF/container.xml: points to the rootfile
  - score.xml: the actual MusicXML content
"""
import os, zipfile

OUT = 'examples/quartertones.mxl'
SRC = 'examples/quartertones.musicxml'

# Don't overwrite silently — fail loudly if the file already exists.
if os.path.exists(OUT):
    raise SystemExit(f'{OUT} already exists; remove it first if you want to regenerate')

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('META-INF/container.xml',
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<container>\n'
        '  <rootfiles>\n'
        '    <rootfile full-path="score.xml"/>\n'
        '  </rootfiles>\n'
        '</container>\n')
    with open(SRC, 'rb') as f:
        z.writestr('score.xml', f.read())

print(f'wrote {OUT} ({os.path.getsize(OUT)} bytes) from {SRC}')

# Verify it's a valid zip and the contents are correct.
with zipfile.ZipFile(OUT) as z:
    print('contents:', z.namelist())
    print('container:', z.read('META-INF/container.xml').decode())
    print('score.xml head:', z.read('score.xml')[:60].decode())