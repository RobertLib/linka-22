#!/usr/bin/env python3
"""Mapped street lamps and catenary masts along line 22 from OpenStreetMap.

Queries an Overpass API mirror for nodes tagged highway=street_lamp and
power=catenary_mast in the route bounding box, keeps those within --distance
metres of the PID shape and stores their positions and lighting tags. The raw
response is cached with its SHA-256 and OSM base timestamp.

  python3 scripts/download-osm-street-lights.py --cache-dir /private/tmp/linka-osm --download

Data © OpenStreetMap contributors, ODbL 1.0.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
TAGS = ("lamp_mount", "support", "light:mount", "lamp_type", "light:method", "light:count", "height", "ref", "operator")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data/street-lights.json"))
    parser.add_argument("--distance", type=float, default=60)
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    route = json.loads(args.route.read_text("utf-8"))
    lats = [p["lat"] for p in route["points"]]
    lons = [p["lon"] for p in route["points"]]
    bbox = (min(lats) - 0.002, min(lons) - 0.003, max(lats) + 0.002, max(lons) + 0.003)
    query = ("[out:json][timeout:120];(node[\"highway\"=\"street_lamp\"]({0},{1},{2},{3});"
             "node[\"power\"=\"catenary_mast\"]({0},{1},{2},{3}););out;").format(*[round(v, 5) for v in bbox])
    raw = args.cache_dir / "street-lights-overpass.json"
    if args.download:
        last = None
        for mirror in MIRRORS:
            for attempt in range(2):
                try:
                    request = Request(mirror, data=urlencode({"data": query}).encode(),
                                      headers={"User-Agent": "Linka22 OSM street-light extraction"})
                    with urlopen(request, timeout=180) as response:
                        data = response.read()
                    parsed = json.loads(data)
                    raw.write_bytes(data)
                    print(f"Overpass response from {mirror}", flush=True)
                    break
                except Exception as error:
                    last = error
                    time.sleep(2 + attempt * 3)
            else:
                continue
            break
        else:
            raise RuntimeError(f"No Overpass mirror answered: {last}")
    data = raw.read_bytes()
    parsed = json.loads(data)
    origin = route["origin"]
    cos = math.cos(math.radians(origin["lat"]))

    def world(lat, lon):
        return (lon - origin["lon"]) * 111320 * cos, -(lat - origin["lat"]) * 111320

    points = [world(lat, lon) for lat, lon in zip(lats, lons)]

    def distance(x, z):
        best = math.inf
        for (x1, z1), (x2, z2) in zip(points, points[1:]):
            dx, dz = x2 - x1, z2 - z1
            length = dx * dx + dz * dz
            t = max(0.0, min(1.0, ((x - x1) * dx + (z - z1) * dz) / length)) if length else 0.0
            best = min(best, math.hypot(x1 + dx * t - x, z1 + dz * t - z))
        return best

    lamps, masts = [], []
    for element in parsed["elements"]:
        if element.get("type") != "node":
            continue
        if distance(*world(element["lat"], element["lon"])) > args.distance:
            continue
        tags = element.get("tags", {})
        record = {"osmId": f"node/{element['id']}", "lat": element["lat"], "lon": element["lon"],
                  **{key: tags[key] for key in TAGS if key in tags}}
        if tags.get("power") == "catenary_mast":
            masts.append(record)
        if tags.get("highway") == "street_lamp":
            lamps.append(record)
    result = {
        "attribution": "© OpenStreetMap contributors",
        "license": "ODbL 1.0",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
        "source": {"query": query, "osmBaseTimestamp": parsed.get("osm3s", {}).get("timestamp_osm_base"),
                   "responseSha256": hashlib.sha256(data).hexdigest()},
        "selection": f"Nodes within {args.distance:g} m of the PID shape",
        "lamps": lamps,
        "catenaryMasts": masts,
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print(json.dumps({"lamps": len(lamps), "catenaryMasts": len(masts),
                      "timestamp": result["source"]["osmBaseTimestamp"]}))


if __name__ == "__main__":
    main()
