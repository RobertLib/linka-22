#!/usr/bin/env python3
"""Reproduce St Ludmila's mapped volumes from cached, unmodified OSM XML.

python3 scripts/extract-landmark-parts.py /private/tmp/corridor-*.osm
No network request or inferred tower location/height is required. The two
surveyed bell towers are tagged building=yes rather than building:part.
"""
import argparse
import hashlib
import json
from pathlib import Path
from enrich_building_parts import load_sources

OFFICIAL = "https://prague.eu/cs/objevujte/kostel-sv-ludmily/"
PART_IDS = ("455314026", "455314027", "455314028", "455314029", "458453993", "1030443422")


def extract(paths):
    nodes, ways, _ = load_sources(paths)
    outline = ways["27854653"]
    parts = []
    for identity in PART_IDS:
        way = ways[identity]
        tags = way["tags"]
        points = [nodes[n] for n in way["nodes"]]
        assert points[0] == points[-1]
        parts.append({
            "osmId": "way/" + identity,
            "partType": tags.get("building:part", "yes"),
            "role": "bell-tower" if tags.get("tower:type") == "bell_tower" else "sanctus-turret" if identity == "455314029" else "nave" if identity == "455314026" else "entrance",
            "height": float(tags["height"]),
            "minHeight": float(tags.get("min_height", 0)),
            "roofHeight": float(tags.get("roof:height", 0)),
            "roofShape": tags.get("roof:shape", "flat"),
            "roofDirection": tags.get("roof:direction"),
            "roofOrientation": tags.get("roof:orientation"),
            "wallColor": tags.get("building:colour", "#927571"),
            "roofColor": tags.get("roof:colour", "gray"),
            "points": points,
            "sourceTags": tags,
        })
    points = [nodes[n] for n in outline["nodes"]]
    center = [sum(p[axis] for p in points[:-1]) / (len(points) - 1) for axis in (0, 1)]
    return {
        "attribution": "© OpenStreetMap contributors, ODbL 1.0; original simplified architectural detail.",
        "sources": [{"file": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths],
        "landmarks": [{
            "name": "Bazilika svaté Ludmily", "osmId": "way/27854653",
            "outlineIds": ["way/27854653", "way/455314027", "way/455314028"],
            "center": center, "footprint": points, "parts": parts,
            "officialSource": OFFICIAL,
            "mapSource": "https://www.openstreetmap.org/way/27854653",
            "dimensions": {"bellTowerHeight": 60, "bellTowerRoofShape": "octagonal-steeple"},
            "approximation": "Exact recorded OSM part footprints/heights. The two surveyed 60m towers use the official octagonal pointed roof shape; lancets, buttress ribs and clocks are simplified original detail. Unmapped lower aisles are omitted rather than assigned unsupported volumes.",
        }],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("public/data/landmark-parts.json"))
    args = parser.parse_args()
    paths = sorted(set(p.resolve() for p in args.sources))
    data = extract(paths)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Saved {len(data['landmarks'][0]['parts'])} mapped St Ludmila parts.")
