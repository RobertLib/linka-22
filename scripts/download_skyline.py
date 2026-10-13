#!/usr/bin/env python3
"""Refresh the compact St Vitus footprint/3D-part snapshot from public OSM.

Run python3 scripts/download_skyline.py, or use --source downloaded-map.xml
to reproduce the extraction without network access. Only mapped building parts
whose centroids are inside the cathedral outline are retained.
"""
import argparse
import datetime
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET

SOURCE_URL = "https://api.openstreetmap.org/api/0.6/map?bbox=14.3990,50.0902,14.4020,50.0914"
DIMENSIONS_URL = "https://prague.eu/en/objevujte/prague-castle-cathedral-of-st-vitus-st-wenceslas-and-st-adalbert-katedrala-sv-vita-vaclava-a-vojtecha/"


def inside(p, polygon):
    result = False
    for a, b in zip(polygon, polygon[1:] + polygon[:1]):
        if (a[0] > p[0]) != (b[0] > p[0]) and p[1] < (
            (b[1] - a[1]) * (p[0] - a[0]) / (b[0] - a[0]) + a[1]
        ):
            result = not result
    return result


def extract(xml, retrieved):
    root = ET.fromstring(xml)
    nodes = {
        n.get("id"): (float(n.get("lat")), float(n.get("lon")))
        for n in root.findall("node")
    }
    ways = {w.get("id"): w for w in root.findall("way")}
    relation = next(r for r in root.findall("relation") if r.get("id") == "15317899")
    chains = [
        [n.get("ref") for n in ways[m.get("ref")].findall("nd")]
        for m in relation.findall("member") if m.get("role") == "outer"
    ]
    ring = chains.pop(0)
    while chains:
        for i, chain in enumerate(chains):
            if ring[-1] == chain[0]:
                ring += chain[1:]
                break
            if ring[-1] == chain[-1]:
                ring += chain[-2::-1]
                break
        else:
            raise ValueError("The cathedral boundary no longer forms one ring")
        chains.pop(i)
    polygon = [nodes[n] for n in ring]
    parts = []
    for identity, way in ways.items():
        tags = {t.get("k"): t.get("v") for t in way.findall("tag")}
        if "building:part" not in tags or "height" not in tags:
            continue
        points = [nodes[n.get("ref")] for n in way.findall("nd")]
        if points[0] != points[-1]:
            continue
        center = tuple(sum(p[j] for p in points[:-1]) / (len(points) - 1) for j in [0, 1])
        if not inside(center, polygon):
            continue
        parts.append({
            "osmId": "way/" + identity, "partType": tags["building:part"],
            "height": float(tags["height"]), "minHeight": float(tags.get("min_height", 0)),
            "roofHeight": float(tags.get("roof:height", 0)),
            "roofShape": tags.get("roof:shape", "flat"),
            "roofDirection": float(tags["roof:direction"]) if tags.get("roof:direction", "").isdigit() else None,
            "roofColor": tags.get("roof:colour"), "points": points,
        })
    return {
        "name": "Katedrála svatého Víta, Václava a Vojtěcha", "osmId": "relation/15317899",
        "center": [50.090858, 14.400502],
        "attribution": "© OpenStreetMap contributors; ODbL 1.0. Original simplified mesh construction and architectural details.",
        "sources": {
            "sourceURL": SOURCE_URL, "footprints": "https://www.openstreetmap.org/relation/15317899",
            "retrieved": retrieved, "license": "https://opendatacommons.org/licenses/odbl/1-0/",
            "dimensions": DIMENSIONS_URL,
            "southTower": "https://www.hrad.cz/file/edee/2017/04/5_katedrala_velka_jizni_vez.pdf",
        },
        "dimensions": {
            "length": 124, "transeptWidth": 60, "westFrontWidth": 37.5,
            "vaultHeight": 33, "westTowerHeight": 82, "southTowerHeight": 96.5,
        },
        "heightOverrides": [
            {"osmId": "way/762259522", "mappedHeight": 85, "renderedHeight": 82, "role": "west-north-tower", "source": DIMENSIONS_URL},
            {"osmId": "way/762259523", "mappedHeight": 85, "renderedHeight": 82, "role": "west-south-tower", "source": DIMENSIONS_URL},
            {"osmId": "way/462765681", "mappedHeight": 99, "renderedHeight": 96.5, "role": "great-south-tower", "source": DIMENSIONS_URL},
        ],
        "approximation": "Mapped outlines, part locations and heights; roof planes, curved helmets, windows and tracery are simplified for a distant skyline, not a surveyed facade model.",
        "footprint": polygon, "parts": parts,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Existing OSM map XML")
    parser.add_argument("--retrieved", default=datetime.date.today().isoformat())
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "public/data/skyline.json")
    args = parser.parse_args()
    xml = args.source.read_bytes() if args.source else urllib.request.urlopen(SOURCE_URL, timeout=30).read()
    data = extract(xml, args.retrieved)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"Saved {len(data['parts'])} mapped parts and {len(data['footprint'])} outline vertices to {args.output}")
