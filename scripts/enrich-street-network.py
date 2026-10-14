#!/usr/bin/env python3
"""Recover exact street and tram geometry and source tags from cached OSM.

Offline reproduction:
  python3 scripts/enrich-street-network.py --source-dir /private/tmp

The supplemental dataset replaces city.json roads/rails by osmId, without
altering that original dataset. Source nodes are neither rounded nor simplified.
Missing widths and access tags are not fabricated. Walking paths on bridges
are retained, with their original bridge/layer tags for the renderer to handle.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET


MOTOR_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service", "busway",
}
WALK_HIGHWAYS = {"footway", "path", "cycleway", "pedestrian"}
ROAD_AREAS = MOTOR_HIGHWAYS | {"junction"}


def read_osm(paths):
    collections = {"node": {}, "way": {}, "relation": {}}
    for path in paths:
        for _, element in ET.iterparse(path, events=("end",)):
            kind = element.tag
            if kind not in collections:
                continue
            identity = element.get("id")
            version = int(element.get("version", "0"))
            collection = collections[kind]
            if identity in collection and collection[identity]["version"] >= version:
                element.clear()
                continue
            item = {
                "tags": {t.get("k"): t.get("v") for t in element.findall("tag")},
                "version": version,
                "timestamp": element.get("timestamp"),
                "sourceFile": path.name,
            }
            if kind == "node":
                item["point"] = [float(element.get("lat")), float(element.get("lon"))]
            elif kind == "way":
                item["nodes"] = [n.get("ref") for n in element.findall("nd")]
            else:
                item["members"] = [dict(m.attrib) for m in element.findall("member")]
            collection[identity] = item
            element.clear()
    return collections["node"], collections["way"], collections["relation"]


def inside(point, ring):
    hit = False
    for a, b in zip(ring, ring[1:]):
        if (a[0] > point[0]) != (b[0] > point[0]) and point[1] < (
            (b[1] - a[1]) * (point[0] - a[0]) / (b[0] - a[0]) + a[1]
        ):
            hit = not hit
    return hit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    city = json.loads((root / "public/data/city.json").read_text())
    route = json.loads((root / "public/data/route22.json").read_text())
    files = sorted(args.source_dir.glob("corridor-*.osm"))
    files += [args.source_dir / name for name in ("prague-center.osm", "prague-river.osm")
              if (args.source_dir / name).exists()]
    if not files:
        raise SystemExit("No cached OSM map extracts found")
    nodes, ways, relations = read_osm(files)

    lon_scale = 111320 * math.cos(math.radians(route["origin"]["lat"]))

    def project(p):
        return ((p[1] - route["origin"]["lon"]) * lon_scale,
                (p[0] - route["origin"]["lat"]) * 111320)

    route_points = [project([p["lat"], p["lon"]]) for p in route["points"]]
    segments = list(zip(route_points, route_points[1:]))
    grid, cell_size = defaultdict(list), 250
    for i, (a, b) in enumerate(segments):
        for x in range(math.floor((min(a[0], b[0]) - 300) / cell_size),
                       math.floor((max(a[0], b[0]) + 300) / cell_size) + 1):
            for y in range(math.floor((min(a[1], b[1]) - 300) / cell_size),
                           math.floor((max(a[1], b[1]) + 300) / cell_size) + 1):
                grid[x, y].append(i)

    def distance(p):
        x, y = project(p)
        best = math.inf
        for i in grid[math.floor(x / cell_size), math.floor(y / cell_size)]:
            a, b = segments[i]
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = dx * dx + dy * dy
            t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / length)) if length else 0
            best = min(best, math.hypot(x - a[0] - t * dx, y - a[1] - t * dy))
        return best

    def near(points, limit):
        if any(distance(p) <= limit for p in points):
            return True
        # Include roads crossing the corridor even when both endpoints are far
        # away. This only selects source geometry; it does not move any nodes.
        for a, b in zip(points, points[1:]):
            pa, pb = project(a), project(b)
            count = math.ceil(math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / 40)
            for n in range(1, count):
                t = n / count
                if distance([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]) <= limit:
                    return True
        return False

    def coords(ids):
        return [nodes[n]["point"] for n in ids] if all(n in nodes for n in ids) else []

    def feature(identity, item, points, node_ids=None):
        tags = item["tags"]
        result = {
            **tags,
            "osmId": identity,
            "points": points,
            "tags": tags,
            "osmVersion": item["version"],
            "osmTimestamp": item["timestamp"],
            "sourceFile": item["sourceFile"],
        }
        if node_ids is not None:
            result["nodeIds"] = node_ids
        if "gauge" in tags and re.fullmatch(r"\d+(?:\.\d+)?", tags["gauge"]):
            result["gauge"] = float(tags["gauge"])
        return result

    existing_roads = {r["osmId"] for r in city["roads"]}
    existing_rails = {r["osmId"] for r in city["rails"]}
    roads, rails, paths, carriageway_areas = [], [], [], []
    incomplete, recovered_roads, recovered_rails = [], set(), set()
    for identity in sorted(ways, key=int):
        item = ways[identity]
        tags, ids = item["tags"], item["nodes"]
        osm_id = "way/" + identity
        points = coords(ids)
        required = osm_id in existing_roads or osm_id in existing_rails
        if len(points) < 2:
            if required:
                incomplete.append(osm_id)
            continue
        highway = tags.get("highway")
        is_rail = osm_id in existing_rails or tags.get("railway") == "tram" and near(points, 185)
        is_road = osm_id in existing_roads or highway in MOTOR_HIGHWAYS and near(points, 185)
        if is_road:
            roads.append(feature(osm_id, item, points, ids))
            recovered_roads.add(osm_id)
        if is_rail:
            rails.append(feature(osm_id, item, points, ids))
            recovered_rails.add(osm_id)
        if highway in WALK_HIGHWAYS and tags.get("area") != "yes" and (
            tags.get("access") not in {"private", "no"}
            and tags.get("foot") != "no"
            and tags.get("indoor") not in {"yes", "room", "corridor"}
            and near(points, 185)
        ):
            paths.append(feature(osm_id, item, points, ids))

    def rings(members):
        pieces = [ways[m["ref"]]["nodes"][:] for m in members
                  if m["type"] == "way" and m["ref"] in ways]
        result = []
        while pieces:
            chain = pieces.pop()
            while chain and chain[0] != chain[-1]:
                for i, piece in enumerate(pieces):
                    if chain[-1] == piece[0]:
                        chain += piece[1:]
                    elif chain[-1] == piece[-1]:
                        chain += list(reversed(piece[:-1]))
                    elif chain[0] == piece[-1]:
                        chain = piece[:-1] + chain
                    elif chain[0] == piece[0]:
                        chain = list(reversed(piece[1:])) + chain
                    else:
                        continue
                    pieces.pop(i)
                    break
                else:
                    break
            points = coords(chain)
            if len(points) >= 4 and chain[0] == chain[-1]:
                result.append((chain, points))
        return result

    def is_carriageway(tags):
        return tags.get("area:highway") in ROAD_AREAS or (
            tags.get("area") == "yes" and tags.get("highway") in MOTOR_HIGHWAYS
        )

    area_members = set()
    for identity in sorted(relations, key=int):
        item = relations[identity]
        if item["tags"].get("type") != "multipolygon" or not is_carriageway(item["tags"]):
            continue
        members = item["members"]
        area_members.update(m["ref"] for m in members if m["type"] == "way")
        holes = rings([m for m in members if m.get("role") == "inner"])
        for ids, points in rings([m for m in members if m.get("role", "") in {"outer", ""}]):
            if near(points, 250):
                area = feature("relation/" + identity, item, points, ids)
                area["holes"] = [ps for _, ps in holes if inside(ps[0], points)]
                carriageway_areas.append(area)
    for identity in sorted(ways, key=int):
        item = ways[identity]
        ids = item["nodes"]
        if identity in area_members or len(ids) < 4 or ids[0] != ids[-1] or not is_carriageway(item["tags"]):
            continue
        points = coords(ids)
        if points and near(points, 250):
            carriageway_areas.append(feature("way/" + identity, item, points, ids))

    missing_roads = sorted(existing_roads - recovered_roads)
    missing_rails = sorted(existing_rails - recovered_rails)
    if missing_roads or missing_rails or incomplete:
        raise SystemExit(f"Incomplete cache: missing roads={missing_roads}, rails={missing_rails}, nodes={incomplete}")

    result = {
        "attribution": "© OpenStreetMap contributors, ODbL 1.0",
        "licenseUrl": "https://www.openstreetmap.org/copyright",
        "source": "Original OSM map API snapshots cached on 2026-10-13, matching the original city data.",
        "sources": [{"file": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files],
        "coverage": "All original city roads and rails, plus available street/tram/walking ways within 185 m and carriageway outlines within 250 m of line 22.",
        "geometrySimplificationMeters": 0,
        "limitations": [
            "OSM records road centerlines or an explicitly tagged lane placement, not surveyed curb geometry. Missing road/lane/path widths remain renderer estimates.",
            "Source tags and bridge/tunnel/layer metadata are preserved. Their absence does not prove a surface, legal access or an at-grade intersection.",
            "Carriageway polygons are included only where actually mapped; data coverage is incomplete. No fabricated street outlines or extra lane counts are added.",
            "OSM tram nodes identify track axes. Railhead profile, switch construction and elevations remain runtime approximations.",
        ],
        "roads": roads,
        "rails": rails,
        "sidewalkPaths": paths,
        "carriagewayAreas": carriageway_areas,
        "counts": {
            "roads": len(roads), "rails": len(rails), "sidewalkPaths": len(paths),
            "carriagewayAreas": len(carriageway_areas),
            "addedRoads": len(recovered_roads - existing_roads),
            "addedRails": len(recovered_rails - existing_rails),
            "explicitRoadWidths": sum("width" in r for r in roads),
            "roadLanePlacement": sum(any(k == "placement" or k.startswith("placement:") for k in r["tags"]) for r in roads),
            "embeddedTramRoads": sum(r.get("embedded_rails") == "tram" for r in roads),
            "roadSidewalkTags": sum(any(k == "sidewalk" or k.startswith("sidewalk:") for k in r["tags"]) for r in roads),
            "bridgePaths": sum(p.get("bridge") not in {None, "no"} for p in paths),
            "interlacedRails": sum(r.get("railway:interlaced") not in {None, "no"} for r in rails),
            "highways": dict(sorted(Counter(r.get("highway") for r in roads).items())),
        },
    }
    output = args.output or root / "public/data/street-network.json"
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps(result["counts"], ensure_ascii=False))
    print(f"Wrote {output} ({output.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
