"""Recover the surrounding city and mapped land cover from cached OSM extracts.

Usage: python3 scripts/extract-city-context.py --source-dir /private/tmp
The cache must contain corridor-*.osm and optionally prague-center.osm.
No network requests, invented footprints or edits to the detailed city dataset.
"""

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    route = json.loads((root / "public/data/route22.json").read_text())
    city = json.loads((root / "public/data/city.json").read_text())
    files = sorted(args.source_dir.glob("corridor-*.osm"))
    center = args.source_dir / "prague-center.osm"
    if center.exists():
        files.append(center)
    if not files:
        raise SystemExit("No cached OSM map extracts found")
    nodes, ways, relations = {}, {}, {}
    for path in files:
        for _, item in ET.iterparse(path, events=("end",)):
            if item.tag not in ("node", "way", "relation"):
                continue
            tags = {t.get("k"): t.get("v") for t in item.findall("tag")}
            identity = item.get("id")
            if item.tag == "node":
                nodes[identity] = [round(float(item.get("lat")), 6), round(float(item.get("lon")), 6)]
            elif item.tag == "way":
                ways[identity] = ([n.get("ref") for n in item.findall("nd")], tags)
            else:
                relations[identity] = ([dict(m.attrib) for m in item.findall("member")], tags)
            item.clear()

    scale_x = 111320 * math.cos(math.radians(route["origin"]["lat"]))

    def project(p):
        return ((p[1] - route["origin"]["lon"]) * scale_x,
                (p[0] - route["origin"]["lat"]) * 111320)

    points = [project([p["lat"], p["lon"]]) for p in route["points"]]
    segments = list(zip(points, points[1:]))
    grid = collections.defaultdict(list)
    for i, (a, b) in enumerate(segments):
        for x in range(math.floor((min(a[0], b[0]) - 850) / 500), math.floor((max(a[0], b[0]) + 850) / 500) + 1):
            for y in range(math.floor((min(a[1], b[1]) - 850) / 500), math.floor((max(a[1], b[1]) + 850) / 500) + 1):
                grid[x, y].append(i)

    def route_distance(p):
        x, y = project(p)
        best = math.inf
        for i in grid[math.floor(x / 500), math.floor(y / 500)]:
            a, b = segments[i]
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = dx * dx + dy * dy
            t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) if length else 0
            best = min(best, math.hypot(x - a[0] - t * dx, y - a[1] - t * dy))
        return best

    def coords(ids):
        return [nodes[n] for n in ids] if all(n in nodes for n in ids) else []

    def area(ps):
        xy = [project(p) for p in ps]
        return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(xy, xy[1:]))) / 2

    def inside(p, ring):
        hit = False
        for a, b in zip(ring, ring[1:]):
            if (a[0] > p[0]) != (b[0] > p[0]) and p[1] < (b[1] - a[1]) * (p[0] - a[0]) / (b[0] - a[0]) + a[1]:
                hit = not hit
        return hit

    def near(ps, distance):
        if not ps:
            return False
        mid = [sum(p[axis] for p in ps[:-1]) / (len(ps) - 1) for axis in (0, 1)]
        return route_distance(mid) < distance or any(route_distance(p) < distance for p in ps[::max(1, len(ps) // 8)])

    def rings(members):
        pieces = [ways[m["ref"]][0][:] for m in members if m["type"] == "way" and m["ref"] in ways]
        result = []
        while pieces:
            chain = pieces.pop()
            while chain and chain[0] != chain[-1]:
                for i, p in enumerate(pieces):
                    if chain[-1] == p[0]:
                        chain += p[1:]
                    elif chain[-1] == p[-1]:
                        chain += list(reversed(p[:-1]))
                    elif chain[0] == p[-1]:
                        chain = p[:-1] + chain
                    elif chain[0] == p[0]:
                        chain = list(reversed(p[1:])) + chain
                    else:
                        continue
                    pieces.pop(i)
                    break
                else:
                    break
            if len(chain) > 3 and chain[0] == chain[-1]:
                ps = coords(chain)
                if ps:
                    result.append(ps)
        return result

    def number(value, default=0):
        match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(?:m)?\s*$", str(value))
        return float(match.group(1)) if match else default

    existing = {b["osmId"] for b in city["buildings"]}
    background, cover, attributes = [], [], {}
    relation_members = set()

    def feature(ps, holes, tags, identity):
        holes = [h for h in holes if inside(h[0], ps)]
        building = tags.get("building")
        below_ground = tags.get("location") == "underground" or tags.get("building:levels") == "0" and number(tags.get("height"), 0) <= 0
        if identity in existing:
            detail = {target: tags[source] for source, target in (
                ("roof:height", "roofHeight"), ("roof:direction", "roofDirection"),
                ("roof:orientation", "roofOrientation"), ("roof:angle", "roofAngle"),
                ("roof:material", "roofMaterial"), ("building:material", "wallMaterial"),
                ("building:colour", "color"), ("building:architecture", "architecture"),
                ("addr:housenumber", "houseNumber"), ("addr:street", "streetName"),
            ) if source in tags}
            if detail:
                attributes[identity] = detail
        if building and not below_ground and building not in ("no", "roof") and identity not in existing and near(ps, 750) and area(ps) > 45:
            fallback = 1 if building in ("garage", "garages", "shed", "hut") else 2 if building in ("house", "detached", "semidetached_house") else 4
            levels = number(tags.get("building:levels"), fallback) or fallback
            height = number(tags.get("height"), 0)
            f = {"osmId": identity, "points": ps, "type": building, "levels": levels,
                 "height": height or levels * 3.3,
                 "heightSource": "OSM" if height else "levels" if "building:levels" in tags else "default"}
            for source, target in (("name", "name"), ("building:colour", "color"), ("building:architecture", "architecture"),
                                   ("roof:shape", "roofShape"), ("roof:colour", "roofColor"), ("roof:height", "roofHeight"), ("roof:direction", "roofDirection"),
                                   ("roof:orientation", "roofOrientation"), ("roof:angle", "roofAngle"), ("roof:material", "roofMaterial")):
                if source in tags:
                    f[target] = tags[source]
            if holes:
                f["holes"] = holes
            background.append(f)
        landuse = tags.get("landuse", "")
        natural, leisure = tags.get("natural", ""), tags.get("leisure", "")
        kind = "urban" if landuse in ("residential", "commercial", "retail", "industrial", "railway", "garages", "construction") else "green" if landuse in ("grass", "forest", "meadow", "recreation_ground", "allotments", "village_green") or natural in ("wood", "grassland", "scrub") or leisure in ("park", "garden", "golf_course") else None
        if kind and near(ps, 850) and area(ps) > 1200:
            f = {"osmId": identity, "kind": kind, "points": ps}
            if tags.get("name"):
                f["name"] = tags["name"]
            if holes:
                f["holes"] = holes
            cover.append(f)

    for identity, (members, tags) in relations.items():
        if tags.get("type") != "multipolygon":
            continue
        if tags.get("building"):
            relation_members.update(m["ref"] for m in members if m["type"] == "way")
        holes = rings([m for m in members if m.get("role") == "inner"])
        for ps in rings([m for m in members if m.get("role", "") in ("outer", "")]):
            feature(ps, holes, tags, "relation/" + identity)
    for identity, (ids, tags) in ways.items():
        if len(ids) < 4 or ids[0] != ids[-1] or identity in relation_members:
            continue
        ps = coords(ids)
        if ps:
            feature(ps, [], tags, "way/" + identity)
    result = {
        "attribution": "© OpenStreetMap contributors, ODbL 1.0",
        "licenseUrl": "https://www.openstreetmap.org/copyright",
        "source": "OSM map API extracts cached on 2026-10-13; same source as city.json",
        "sources": [{"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files],
        "coverage": "Available cached map coverage within 750 m of line 22 for background buildings and 850 m for land cover; not complete beyond the original extracts.",
        "limitations": ["Only mapped footprints; no invented infill. Untagged heights and roof forms remain estimates.", "Land-use polygons describe ground character, not a surveyed paving surface or precise boundary."],
        "buildings": background, "landCover": cover, "buildingAttributes": attributes,
        "counts": {"buildings": len(background), "landCover": len(cover), "buildingAttributes": len(attributes)},
    }
    output = root / "public/data/city-context.json"
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    print(f"Recovered {len(background)} surrounding buildings, {len(cover)} land-cover polygons and {len(attributes)} building tag supplements ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
