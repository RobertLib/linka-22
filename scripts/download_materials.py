"""Download a small, reproducible CC0 PBR set using Poly Haven's public API."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'textures'
OUT.mkdir(parents=True, exist_ok=True)
AGENT = 'PragueLine22 local simulator development'
SETS = {
    'cobblestone_floor_02': ('cobble', '2k'),
    'asphalt_02': ('asphalt', '1k'),
    'plastered_wall_02': ('plaster', '1k'),
    'roof_tiles_14': ('roof', '2k'),
    'ceramic_roof_01': ('roof-red', '2k'),
    'aerial_grass_rock': ('grass', '1k'),
    'gravel_stones': ('ballast', '1k'),
    'concrete_pavement': ('concrete-paving', '1k'),
}

def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()

def metadata(asset):
    cache = Path('/private/tmp/prague-pbr-' + asset + '.json')
    return json.loads(cache.read_text()) if cache.exists() else json.loads(fetch('https://api.polyhaven.com/files/' + asset))

jobs = []
manifest = {'license': 'CC0 1.0', 'licenseUrl': 'https://polyhaven.com/license', 'assets': []}
for asset, (name, resolution) in SETS.items():
    data = metadata(asset)
    maps = {}
    for key, short in [('Diffuse', 'color'), ('nor_gl', 'normal'), ('Rough', 'roughness')]:
        info = data[key][resolution]['jpg']
        destination = OUT / (name + '-' + short + '.jpg')
        jobs.append((info, destination))
        maps[short] = '/textures/' + destination.name
    manifest['assets'].append({'id': asset, 'name': name, 'url': 'https://polyhaven.com/a/' + asset, 'resolution': resolution, 'maps': maps})
hdr = metadata('urban_alley_01')['hdri']['1k']['hdr']
jobs.append((hdr, OUT / 'urban-lighting.hdr'))
manifest['assets'].append({'id': 'urban_alley_01', 'name': 'environment', 'url': 'https://polyhaven.com/a/urban_alley_01', 'file': '/textures/urban-lighting.hdr'})
sky = metadata('kloppenheim_06_puresky')['hdri']['2k']['hdr']
jobs.append((sky, OUT / 'sky-clear.hdr'))
manifest['assets'].append({'id': 'kloppenheim_06_puresky', 'name': 'sky', 'url': 'https://polyhaven.com/a/kloppenheim_06_puresky', 'file': '/textures/sky-clear.hdr', 'sunElevation': 8})
# Pure skies for the real solar elevation over Prague. The elevation is the
# photographed sun's height in degrees, measured with daylight.js.
SKIES = {
    'autumn_field_puresky': ('sky-28.hdr', 29),
    'syferfontein_18d_clear_puresky': ('sky-18.hdr', 18),
    'syferfontein_0d_clear_puresky': ('sky-sunset.hdr', 0),
    'qwantani_dusk_2_puresky': ('sky-dusk.hdr', -4),
    'kloppenheim_07_puresky': ('sky-night.hdr', None),
    'kloofendal_overcast_puresky': ('sky-overcast.hdr', None),
}
for asset, (file, elevation) in SKIES.items():
    jobs.append((metadata(asset)['hdri']['2k']['hdr'], OUT / file))
    entry = {'id': asset, 'name': 'sky', 'url': 'https://polyhaven.com/a/' + asset, 'file': '/textures/' + file}
    if elevation is not None:
        entry['sunElevation'] = elevation
    manifest['assets'].append(entry)
manifest['assets'].append({'id': 'tree_small_02', 'name': 'tree', 'url': 'https://polyhaven.com/a/tree_small_02', 'file': '/models/tree.glb', 'derived': ['/textures/tree-impostor.png'], 'modified': 'Blender planar leaf simplification, trunk/branch decimation, packed materials, distant transparent render; see scripts/prepare_tree.py'})

def download(job):
    info, destination = job
    if destination.exists() and hashlib.md5(destination.read_bytes()).hexdigest() == info['md5']:
        return
    data = fetch(info['url'])
    if hashlib.md5(data).hexdigest() != info['md5']:
        raise ValueError('Checksum mismatch: ' + destination.name)
    destination.write_bytes(data)
    print(destination.name, len(data), flush=True)

with ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(download, jobs))
(OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Downloaded and verified', len(jobs), 'CC0 assets.')
