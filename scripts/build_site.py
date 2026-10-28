"""Package Suhjae and its pinned Sohjae runtime; no network or build dependencies."""
from pathlib import Path
import hashlib, json, shutil
ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'web/app'
OUT = ROOT / 'site'
OUT.mkdir(exist_ok=True)
for name in ['index.html','app.css','app.js','store.js','browser-sync.js','offline.js','export-zip.js']:
    text = (APP / name).read_text()
    if name == 'index.html':
        text = text.replace('../../vendor/sohjae/', './vendor/sohjae/')
    (OUT / name).write_text(text)
shutil.copytree(ROOT / 'vendor', OUT / 'vendor', dirs_exist_ok=True)
(OUT / '.nojekyll').touch()
manifest = json.loads((ROOT / 'vendor/sohjae/manifest.json').read_text())
for name, expected in manifest['files'].items():
    assert hashlib.sha256((ROOT / 'vendor/sohjae' / name).read_bytes()).hexdigest() == expected, name
# Include every imported runtime dependency, including dynamically loaded modules.
urls = ['./', './index.html','./app.css','./app.js','./store.js','./browser-sync.js','./offline.js','./export-zip.js']
urls += ['./vendor/sohjae/' + name for name in manifest['files']]
for destination, prefix in [(OUT, './vendor/sohjae/'), (APP, '../../vendor/sohjae/')]:
    records = []
    for url in urls:
        url = url.replace('./vendor/sohjae/', prefix)
        path = destination / ('index.html' if url == './' else url)
        records.append({'url': url, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    encoded = json.dumps(records, separators=(',', ':'))
    build = hashlib.sha256(encoded.encode()).hexdigest()[:20]
    worker = (APP / 'offline-worker.js').read_text().replace("const BUILD='development';", 'const BUILD=' + json.dumps(build) + ';').replace('const ASSETS=[];', 'const ASSETS=' + encoded + ';')
    (destination / 'sw.js').write_text(worker)
print('Built site/; verified pinned SDK and offline asset hashes.')
