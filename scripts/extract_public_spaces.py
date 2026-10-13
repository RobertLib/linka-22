#!/usr/bin/env python3
"""Extract actual public-space outlines, walking paths and furniture from OSM.

Offline reproduction:
  python3 scripts/extract_public_spaces.py --output public/data/public-spaces.json \
    /private/tmp/prague-center.osm /private/tmp/prague-river.osm \
    /private/tmp/corridor-*.osm

Coordinates are preserved, including multipolygon courtyard/island holes.
Ground-level public ways are retained; stairs, bridges, indoor circulation,
private ways and incomplete rings are deliberately omitted. Missing path
widths and furniture dimensions remain renderer estimates, never source data.
"""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET


def tags(element):
    return {t.get("k"): t.get("v") for t in element.findall("tag")}


def ground_public(t):
    try:
        min_height = float(t.get("min_height", "0").split(" ")[0] or "0")
    except ValueError:
        return False  # Unknown clearance does not justify a ground-level mesh.
    return not (
        t.get("access") in {"private", "no"}
        or t.get("foot") == "no"
        or t.get("indoor") in {"yes", "room", "corridor"}
        or t.get("bridge") not in {None, "no"}
        or t.get("tunnel") not in {None, "no"}
        or t.get("highway") == "steps"
        or t.get("area:highway") == "steps"
        or min_height > 0
    )


def is_area(t):
    return ground_public(t) and (
        t.get("area:highway") in {
            "footway", "pedestrian", "padestrian", "residential", "tertiary",
            "secondary", "unclassified", "service", "junction", "traffic_island",
        }
        or t.get("area") == "yes" and t.get("highway") in {"pedestrian", "footway"}
    )


def inside(p, ring):
    result = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if (a[0] > p[0]) != (b[0] > p[0]) and p[1] < (
            (b[1] - a[1]) * (p[0] - a[0]) / (b[0] - a[0]) + a[1]
        ):
            result = not result
    return result


def extract(paths, route_path):
    nodes, ways, relations = {}, {}, {}
    for path in paths:
        for _, element in ET.iterparse(path, events=("end",)):
            if element.tag not in {"node", "way", "relation"}:
                continue
            identity = element.get("id")
            version = int(element.get("version", "0"))
            collection = {"node": nodes, "way": ways, "relation": relations}[element.tag]
            if identity in collection and collection[identity][0] >= version:
                element.clear()
                continue
            t = tags(element)
            if element.tag == "node":
                item = {"point": [float(element.get("lat")), float(element.get("lon"))], "tags": t}
            elif element.tag == "way":
                item = {"nodes": [n.get("ref") for n in element.findall("nd")], "tags": t}
            else:
                item = {"members": [m.attrib.copy() for m in element.findall("member")], "tags": t}
            collection[identity] = (version, item)
            element.clear()
    nodes = {k: v[1] for k, v in nodes.items()}
    ways = {k: v[1] for k, v in ways.items()}
    relations = {k: v[1] for k, v in relations.items()}
    route = json.loads(Path(route_path).read_text())
    lat0, lon0 = route["origin"]["lat"], route["origin"]["lon"]
    lon_scale, lat_scale = 111320 * math.cos(math.radians(lat0)), 111320
    project = lambda p: ((p[1] - lon0) * lon_scale, (p[0] - lat0) * lat_scale)
    route_points = [project([p["lat"], p["lon"]]) for p in route["points"]]
    segments = list(zip(route_points, route_points[1:]))
    cells, cell_size = defaultdict(list), 250
    for i, (a, b) in enumerate(segments):
        for x in range(math.floor((min(a[0], b[0]) - 300) / cell_size), math.floor((max(a[0], b[0]) + 300) / cell_size) + 1):
            for y in range(math.floor((min(a[1], b[1]) - 300) / cell_size), math.floor((max(a[1], b[1]) + 300) / cell_size) + 1):
                cells[x, y].append(i)

    def distance(p):
        x, y = project(p)
        best = math.inf
        for i in cells[math.floor(x / cell_size), math.floor(y / cell_size)]:
            a, b = segments[i]
            dx, dy = b[0] - a[0], b[1] - a[1]
            t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy or 1)))
            best = min(best, math.hypot(x - a[0] - dx * t, y - a[1] - dy * t))
        return best

    def near(points, limit):
        return bool(points) and any(distance(p) < limit for p in points)

    def coords(ids):
        return [nodes[n]["point"] for n in ids] if all(n in nodes for n in ids) else []

    def rings(members):
        pieces = [ways[m["ref"]]["nodes"][:] for m in members if m["type"] == "way" and m["ref"] in ways]
        result = []
        while pieces:
            ring = pieces.pop()
            while ring and ring[0] != ring[-1]:
                for i, chain in enumerate(pieces):
                    if ring[-1] == chain[0]: ring += chain[1:]
                    elif ring[-1] == chain[-1]: ring += chain[-2::-1]
                    elif ring[0] == chain[-1]: ring = chain[:-1] + ring
                    elif ring[0] == chain[0]: ring = chain[1:][::-1] + ring
                    else: continue
                    pieces.pop(i)
                    break
                else:
                    break
            if len(ring) > 3 and ring[0] == ring[-1]:
                points = coords(ring)
                if points: result.append(points)
        return result

    def attributes(t, identity):
        f = {"osmId": identity}
        for k in ["name", "surface", "width", "highway", "area:highway", "footway", "lit", "direction", "material", "colour", "backrest", "seats", "bicycle", "access", "natural", "landuse"]:
            if k in t: f[k] = t[k]
        return f

    areas, walking, furniture = [], [], []
    relation_members = set()
    for identity, r in sorted(relations.items(), key=lambda x: int(x[0])):
        if r["tags"].get("type") != "multipolygon" or not is_area(r["tags"]):
            continue
        outers = rings([m for m in r["members"] if m.get("role") in {"outer", ""}])
        holes = rings([m for m in r["members"] if m.get("role") == "inner"])
        for outer in outers:
            if near(outer, 250):
                f = {**attributes(r["tags"], "relation/" + identity), "points": outer}
                contained = [hole for hole in holes if inside(hole[0], outer)]
                if contained: f["holes"] = contained
                areas.append(f)
        relation_members.update(m["ref"] for m in r["members"] if m["type"] == "way")
    for identity, w in sorted(ways.items(), key=lambda x: int(x[0])):
        t, points = w["tags"], coords(w["nodes"])
        if len(points) < 2 or not ground_public(t):
            continue
        if is_area(t) and len(points) > 3 and points[0] == points[-1]:
            if identity not in relation_members and near(points, 250):
                areas.append({**attributes(t, "way/" + identity), "points": points})
        elif t.get("highway") in {"footway", "path", "cycleway"} and t.get("footway") != "crossing" and near(points, 180):
            walking.append({**attributes(t, "way/" + identity), "points": points})
    for identity, node in sorted(nodes.items(), key=lambda x: int(x[0])):
        t, p = node["tags"], node["point"]
        kind = t.get("amenity") if t.get("amenity") in {"bench", "waste_basket"} else "bollard" if t.get("barrier") == "bollard" else None
        if kind and ground_public(t) and distance(p) < 140:
            furniture.append({**attributes(t, "node/" + identity), "kind": kind, "lat": p[0], "lon": p[1]})
    return {
        "attribution": "© OpenStreetMap contributors, ODbL 1.0. Ground-level public space geometry recovered from the project's 13.10.2026 OSM snapshots.",
        "sources": [{"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths],
        "sourceUrl": "https://www.openstreetmap.org/",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
        "coverage": "Mapped areas within 250 m, walking paths within 180 m, furniture within 140 m of line 22. Coordinates have not been simplified or moved.",
        "limitations": ["OSM surface and width tags are retained where available. Missing dimensions, pavement patterns and furniture mesh shapes are visual estimates.", "Indoor/private circulation, steps and bridge/tunnel paths are omitted. Runtime terrain interpolation is approximate.", "Only complete multipolygon rings are retained; inner islands and courtyards remain holes."],
        "areas": areas, "paths": walking, "furniture": furniture,
        "counts": {"areas": len(areas), "paths": len(walking), "furniture": len(furniture), "holes": sum(len(a.get("holes", [])) for a in areas)},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", nargs="+", type=Path)
    parser.add_argument("--route", default="public/data/route22.json")
    parser.add_argument("--output", default="public/data/public-spaces.json", type=Path)
    args = parser.parse_args()
    data = extract(args.sources, args.route)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps(data["counts"], ensure_ascii=False))
