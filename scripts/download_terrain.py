"""Vendor Copernicus GLO-90 samples for the full visible line 22 landscape.

Source: https://open-meteo.com/en/docs/elevation-api (100 points/request).
No service is contacted by the game itself. Only public map coordinates leave
this script, and the downloaded elevations are preserved without smoothing.
"""
import json
import math
from pathlib import Path
import urllib.parse
import urllib.request
import urllib.error
import time

ROOT = Path(__file__).resolve().parents[1]
data = json.loads((ROOT / "public/data/route22.json").read_text())
origin = data["origin"]
cosine = math.cos(math.radians(origin["lat"]))
points = [((p["lon"] - origin["lon"]) * 111320 * cosine,
           -(p["lat"] - origin["lat"]) * 111320) for p in data["points"]]
step = 180
margin = 850
min_x = math.floor((min(p[0] for p in points) - margin) / step) * step
min_z = math.floor((min(p[1] for p in points) - margin) / step) * step
nx = math.ceil((max(p[0] for p in points) + margin - min_x) / step) + 1
nz = math.ceil((max(p[1] for p in points) + margin - min_z) / step) + 1

cells = [(iz * nx + ix, min_x + ix * step, min_z + iz * step)
         for iz in range(nz) for ix in range(nx)]
elevations = [None] * (nx * nz)
cache = Path("/private/tmp/linka-22-terrain-samples.json")
cached = json.loads(cache.read_text()) if cache.exists() else {}
existing = ROOT / "public/data/terrain.json"
if existing.exists():
    previous = json.loads(existing.read_text())
    if all(previous.get(k) == v for k, v in (("minX", min_x), ("minZ", min_z),
                                           ("step", step), ("nx", nx), ("nz", nz))):
        elevations = previous["elevations"]
cells = [(i, x, z) for i, x, z in cells if elevations[i] is None]
for start in range(0, len(cells), 100):
    batch = cells[start:start + 100]
    params = urllib.parse.urlencode({
        "latitude": ",".join(f'{origin["lat"] - z / 111320:.6f}' for _, x, z in batch),
        "longitude": ",".join(f'{origin["lon"] + x / (111320 * cosine):.6f}' for _, x, z in batch),
    })
    if params in cached:
        values = cached[params]
    else:
        request = urllib.request.Request("https://api.open-meteo.com/v1/elevation?" + params,
                                         headers={"User-Agent": "linka-22-terrain/1.0"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=40) as response:
                    values = json.load(response)["elevation"]
                break
            except urllib.error.HTTPError as error:
                if error.code not in (429, 502, 503, 504) or attempt == 4:
                    raise
                print(f"Elevation service HTTP {error.code}; retrying in 60 seconds", flush=True)
                time.sleep(60)
        cached[params] = values
        cache.write_text(json.dumps(cached))
        time.sleep(12)
    if len(values) != len(batch) or any(not isinstance(v, (int, float)) for v in values):
        raise ValueError("Invalid elevation response")
    for (index, _, _), value in zip(batch, values):
        elevations[index] = value
    print(f"Terrain samples: {min(start + 100, len(cells))}/{len(cells)}", flush=True)

result = {
    "attribution": "Copernicus DEM 2021 GLO-90 / Open-Meteo, CC BY 4.0",
    "source": "https://open-meteo.com/en/docs/elevation-api",
    "downloaded": "2026-10-13", "resolutionMeters": 90,
    "origin": origin, "minX": min_x, "minZ": min_z, "step": step,
    "nx": nx, "nz": nz, "sampleCount": sum(v is not None for v in elevations), "elevations": elevations,
    "limitations": "Surface elevation samples, 180 m grid; not surveyed track or building foundations.",
}
(ROOT / "public/data/terrain.json").write_text(json.dumps(result, separators=(",", ":")) + "\n")
