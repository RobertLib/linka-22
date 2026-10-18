#!/usr/bin/env python3
"""Extract individual trees near line 22 from IPR Praha shared greenery data.

Reads the cached pages of scripts/download-ipr-greenery.py ("Sdílená data o
zeleni - vegetační prvky - body", CC BY 4.0, datový podklad © IPR Praha) and
keeps elements of type 71 (Strom, an individual tree) within --distance metres
of the PID route. The layer is stored in Web Mercator; its WGS84 output is an
exact conversion. Tree category follows kod_drevin; street-row membership
follows id_strom. Heights and species are not published and stay estimates.

  python3 scripts/extract-ipr-trees.py --cache-dir /private/tmp/linka-ipr-greenery
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

CATEGORY = {1: "conifer", 2: "deciduous", 3: "fruit", 4: "mixed"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data/trees-ipr.json"))
    parser.add_argument("--distance", type=float, default=300)
    args = parser.parse_args()
    manifest = json.loads((args.cache_dir / "manifest.json").read_text("utf-8"))
    layer = manifest["layers"]["vegetation"]
    route = json.loads(args.route.read_text("utf-8"))
    origin = route["origin"]
    cos = math.cos(math.radians(origin["lat"]))

    def world(lat, lon):
        return (lon - origin["lon"]) * 111320 * cos, -(lat - origin["lat"]) * 111320

    # Route samples every ~10 m in a coarse grid for the distance test.
    samples = []
    points = [world(p["lat"], p["lon"]) for p in route["points"]]
    for (x1, z1), (x2, z2) in zip(points, points[1:]):
        steps = max(1, int(math.hypot(x2 - x1, z2 - z1) / 10))
        samples += [(x1 + (x2 - x1) * k / steps, z1 + (z2 - z1) * k / steps) for k in range(steps)]
    samples.append(points[-1])
    cell = args.distance
    grid = {}
    for x, z in samples:
        grid.setdefault((math.floor(x / cell), math.floor(z / cell)), []).append((x, z))

    def distance(x, z):
        ix, iz = math.floor(x / cell), math.floor(z / cell)
        return min((math.hypot(x - a, z - b) for dx in (-1, 0, 1) for dz in (-1, 0, 1)
                    for a, b in grid.get((ix + dx, iz + dz), ())), default=math.inf)

    trees, seen, counts = [], set(), {}
    for page in layer["pages"]:
        data = (args.cache_dir / page["file"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != page["sha256"]:
            raise ValueError(f"Cached page differs from its manifest: {page['file']}")
        for feature in json.loads(data)["features"]:
            attributes = feature["attributes"]
            if attributes.get("kod_vp") != 71:
                continue
            identity = attributes.get("globalid")
            if identity in seen:
                continue
            seen.add(identity)
            for lon, lat in feature["geometry"]["points"]:
                if distance(*world(lat, lon)) > args.distance:
                    continue
                category = CATEGORY.get(attributes.get("kod_drevin"), "unknown")
                counts[category] = counts.get(category, 0) + 1
                trees.append([round(lat, 7), round(lon, 7), category, 1 if attributes.get("id_strom") else 0])
    trees.sort()
    result = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "source": {
            "title": layer["title"],
            "catalogue": layer["catalogue"],
            "service": layer["service"],
            "lastEditDate": layer.get("lastEditDate"),
            "pages": [{"file": page["file"], "sha256": page["sha256"]} for page in layer["pages"]],
        },
        "selection": f"kod_vp 71 (Strom) within {args.distance:g} m of the PID shape",
        "fields": ["lat", "lon", "category (kod_drevin)", "streetRow (id_strom present)"],
        "limitations": [
            "The shared greenery data covers trees managed by the city districts; private gardens are incomplete.",
            "Height, crown size and species are not published and are estimated in the scene.",
        ],
        "counts": dict(sorted(counts.items())),
        "trees": trees,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print(json.dumps({"trees": len(trees), **counts}))


if __name__ == "__main__":
    main()
