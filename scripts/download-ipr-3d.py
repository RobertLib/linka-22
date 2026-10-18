#!/usr/bin/env python3
"""Acquire the public IPR Praha 3D model sheets along line 22.

The open-data catalogue of IPR Praha (DCAT-AP feed) lists the photogrammetric
"Budovy 3D / Buildings 3D model" and the lidar "Model terénu 3D / Elevation
model" as per-sheet archives of the 1:5000 map series. This script selects all
sheets of the official sheet index within --margin metres of the PID route,
downloads their shapefile archives and records URLs and SHA-256:

  python3 scripts/download-ipr-3d.py --cache-dir /private/tmp/linka-ipr-3d --download
  python3 scripts/download-ipr-3d.py --cache-dir /private/tmp/linka-ipr-3d   # verify only

Licence: CC BY 4.0, attribution "datový podklad © IPR Praha".
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DCAT = "https://opendata.geoportalpraha.cz/api/feed/dcat-ap/2.1.1.json"
SHEETS = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/MAP_CUR_MAP_ML_5000_P/FeatureServer/0/query"
DATASETS = {
    "buildings": ("Budovy 3D / Buildings 3D model", "BD3"),
    "terrain": ("Model terénu 3D / Elevation model", "TER"),
}
USER_AGENT = "Linka22 public IPR 3D model source preparation"


def fetch(url):
    last_error = None
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=600) as response:
                return response.read()
        except Exception as error:
            last_error = error
            time.sleep(1 + 2 * attempt)
    raise RuntimeError(f"IPR read failed for {url}: {last_error}")


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def route_samples(route_path, spacing=20):
    route = json.loads(route_path.read_text("utf-8"))
    points = [(p["lat"], p["lon"]) for p in route["points"]]
    result = []
    for (a_lat, a_lon), (b_lat, b_lon) in zip(points, points[1:]):
        length = math.hypot((b_lat - a_lat) * 111320, (b_lon - a_lon) * 71500)
        steps = max(1, int(length / spacing))
        result.extend((a_lat + (b_lat - a_lat) * i / steps, a_lon + (b_lon - a_lon) * i / steps)
                      for i in range(steps))
    result.append(points[-1])
    return result


def near_polygon(ring, samples, margin):
    def inside(lat, lon):
        hit = False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
                hit = not hit
        return hit

    for lat, lon in samples:
        if inside(lat, lon):
            return True
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            ax, ay = (x1 - lon) * 71500, (y1 - lat) * 111320
            bx, by = (x2 - lon) * 71500, (y2 - lat) * 111320
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy + 1e-12)))
            if math.hypot(ax + t * dx, ay + t * dy) < margin:
                return True
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--margin", type=float, default=800)
    parser.add_argument("--terrain-margin", type=float, default=1000)
    parser.add_argument("--manifest", type=Path, default=Path("docs/ipr-3d-manifest.json"))
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    catalogue_file = args.cache_dir / "dcat-ap.json"
    sheets_file = args.cache_dir / "sheets-1-5000.geojson"
    if args.download:
        catalogue_file.write_bytes(fetch(DCAT))
        sheets_file.write_bytes(fetch(SHEETS + "?" + urlencode({
            "where": "1=1", "outFields": "nml,cml", "returnGeometry": "true",
            "outSR": 4326, "f": "geojson", "resultRecordCount": 2000,
        })))
    catalogue = json.loads(catalogue_file.read_text("utf-8"))
    index = json.loads(sheets_file.read_text("utf-8"))
    samples = route_samples(args.route)[::3]
    lats = [lat for lat, _ in samples]
    lons = [lon for _, lon in samples]
    # Terrain must cover the complete rendered terrain rectangle (route
    # bounding box plus 700 m in src/world.js); buildings only the corridor.
    west, east = min(lons) - args.terrain_margin / 71500, max(lons) + args.terrain_margin / 71500
    south, north = min(lats) - args.terrain_margin / 111320, max(lats) + args.terrain_margin / 111320

    def in_rectangle(ring):
        xs = [x for x, _ in ring]
        ys = [y for _, y in ring]
        return min(xs) <= east and max(xs) >= west and min(ys) <= north and max(ys) >= south

    sheet_kinds = {}
    for feature in index["features"]:
        ring = feature["geometry"]["coordinates"][0]
        kinds = set()
        if in_rectangle(ring):
            kinds.add("terrain")
        if near_polygon(ring, samples, args.margin):
            kinds.add("buildings")
        if kinds:
            sheet_kinds[feature["properties"]["nml"]] = kinds
    selected = sorted(sheet_kinds)
    distributions = {}
    for dataset in catalogue["dcat:dataset"]:
        title = str(dataset.get("dct:title"))
        for key, (wanted, prefix) in DATASETS.items():
            if title == wanted:
                distributions[key] = {
                    "title": title,
                    "identifier": dataset.get("dct:identifier"),
                    "modified": dataset.get("dct:modified"),
                    "landingPage": dataset.get("@id"),
                    "license": dataset.get("dct:license"),
                    "urls": {str(item.get("dct:title")): item.get("dcat:accessURL", {}).get("@id")
                             for item in dataset.get("dcat:distribution", [])},
                    "prefix": prefix,
                }
    if set(distributions) != set(DATASETS):
        raise RuntimeError("The IPR catalogue no longer lists both 3D datasets")
    sheets = []
    for name in selected:
        place, number = name.split(" ")
        entry = {"name": name}
        for key, item in distributions.items():
            if key not in sheet_kinds[name]:
                continue
            label = f"{item['prefix']}_{place[:4]}_{number}_shp"
            url = item["urls"].get(label)
            if not url:
                raise RuntimeError(f"Catalogue lacks {label}")
            path = args.cache_dir / f"{label}.zip"
            if args.download and not path.exists():
                print(f"Downloading {label}", flush=True)
                partial = path.with_suffix(".partial")
                partial.write_bytes(fetch(url))
                partial.replace(path)
            if not path.exists():
                raise RuntimeError(f"Missing {path}; run with --download first")
            entry[key] = {"file": path.name, "url": url, "sha256": sha256(path), "bytes": path.stat().st_size}
        sheets.append(entry)
        print(f"Verified sheet {name}", flush=True)
    manifest = {
        "sourceName": "IPR Praha 3D model (Budovy 3D, Model terénu 3D)",
        "catalogue": DCAT,
        "sheetIndex": SHEETS.rsplit("/query", 1)[0],
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "rulesUrl": "https://geoportalpraha.cz/backend/getdokument/1",
        "crs": "EPSG:5514 (S-JTSK / Krovak East North), heights Bpv",
        "selection": (f"Buildings: 1:5000 sheets within {args.margin:g} m of the PID line-22 shape; "
                      f"terrain: sheets intersecting its bounding box expanded by {args.terrain_margin:g} m"),
        "datasets": {key: {k: v for k, v in item.items() if k != "urls"} for key, item in distributions.items()},
        "sheetIndexSha256": hashlib.sha256(sheets_file.read_bytes()).hexdigest(),
        "sheets": sheets,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"sheets": len(sheets), "bytes": sum(
        sheet[key]["bytes"] for sheet in sheets for key in DATASETS if key in sheet)}))


if __name__ == "__main__":
    main()
