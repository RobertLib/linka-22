#!/usr/bin/env python3
"""Recover recorded OSM building-part heights without changing city footprints.

Usage (offline; source snapshots must already exist):
  python3 scripts/enrich_building_parts.py --city public/data/city.json \
    --in-place /private/tmp/prague-center.osm /private/tmp/corridor-*.osm

Without --in-place or --output this only prints the proposed enrichment.
Only recorded numeric height/building:levels tags are used. Safe corrections
require ground-contact body parts covering at least 60% of the footprint,
with principal floor counts spanning no more than one floor and eaves heights
spanning no more than 3.3 m. Tower/roof maxima are never spread over a complex.
A part is assigned
by an explicit type=building relation, or conservative polygon containment
with a 1 m tolerance for the city's 0.55 m simplified, rounded outlines.
The primary body remains a coarse extrusion, not a reconstruction of individual
part volumes. OSM roof:height is subtracted for eaves; min_height is not added.
When only levels are available, the existing 3.3 m normalization is retained.
https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings
"""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET

TAG_KEYS = ("building:part", "height", "building:levels", "min_height",
            "building:min_level", "roof:height", "roof:levels", "roof:shape")
CELL_METERS = 100
TOLERANCE_METERS = 1


def number(value, zero=False):
    match = re.fullmatch(r"\s*(\d+(?:[.,]\d+)?)\s*(?:m)?\s*", str(value or ""))
    if not match:
        return None
    result = float(match[1].replace(",", "."))
    return result if math.isfinite(result) and (result > 0 or zero and result == 0) else None



def body_height(tags):
    if tags.get("building:part") == "roof":
        return None, None
    if (number(tags.get("min_height"), zero=True) or 0) > 0:
        return None, None
    if (number(tags.get("building:min_level"), zero=True) or 0) > 0:
        return None, None
    levels = number(tags.get("building:levels"))
    recorded_height = number(tags.get("height"))
    roof_height = number(tags.get("roof:height"), zero=True)
    if recorded_height is not None and roof_height is not None:
        eaves = recorded_height - roof_height
        return (eaves, "OSM") if eaves > 0 else (None, None)
    if recorded_height is not None and tags.get("roof:shape") == "flat":
        return recorded_height, "OSM"
    if levels:
        return levels * 3.3, "levels"
    return None, None


def footprint_samples(building):
    outer, holes = building["outer"], building["holes"]
    x0, y0, x1, y1 = building["bounds"]
    # Dense enough for street buildings, bounded for large complexes.
    step = max(1.5, math.sqrt(building["area"] / 2500))
    samples = []
    for yi in range(math.ceil((y1 - y0) / step)):
        for xi in range(math.ceil((x1 - x0) / step)):
            p = (x0 + (xi + 0.5) * step, y0 + (yi + 0.5) * step)
            if inside(p, outer) and not any(inside(p, hole) for hole in holes):
                samples.append(p)
    return samples


def load_sources(paths):
    nodes, ways, relations = {}, {}, {}
    for path in paths:
        for _, element in ET.iterparse(path, events=("end",)):
            kind = element.tag
            if kind not in ("node", "way", "relation"):
                continue
            identity = element.attrib["id"]
            version = int(element.attrib.get("version", 0))
            target = nodes if kind == "node" else ways if kind == "way" else relations
            if identity in target and target[identity][0] >= version:
                element.clear()
                continue
            if kind == "node":
                item = (float(element.attrib["lat"]), float(element.attrib["lon"]))
            else:
                tags = {t.attrib["k"]: t.attrib["v"] for t in element.findall("tag")}
                if kind == "way":
                    item = {"nodes": [n.attrib["ref"] for n in element.findall("nd")], "tags": tags}
                else:
                    item = {"members": [m.attrib.copy() for m in element.findall("member")], "tags": tags}
            target[identity] = (version, item)
            element.clear()
    return ({k: v[1] for k, v in nodes.items()}, {k: v[1] for k, v in ways.items()},
            {k: v[1] for k, v in relations.items()})


def rings(members, ways):
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
        if len(chain) >= 4 and chain[0] == chain[-1]:
            result.append(chain)
    return result


def area(ring):
    return abs(sum(a[0] * b[1] - b[0] * a[1]
                   for a, b in zip(ring, ring[1:] + ring[:1]))) / 2


def boundary_distance(point, ring):
    best = math.inf
    for a, b in zip(ring, ring[1:] + ring[:1]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        squared = dx * dx + dy * dy
        t = min(1, max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / squared)) if squared else 0
        best = min(best, math.hypot(point[0] - a[0] - dx * t, point[1] - a[1] - dy * t))
    return best


def inside(point, ring):
    x, y = point
    result = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


def covered(part_ring, building):
    samples = part_ring + [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                           for a, b in zip(part_ring, part_ring[1:] + part_ring[:1])]
    for p in samples:
        if not inside(p, building["outer"]) and boundary_distance(p, building["outer"]) > TOLERANCE_METERS:
            return False
        for hole in building["holes"]:
            if inside(p, hole) and boundary_distance(p, hole) > TOLERANCE_METERS:
                return False
    return True


def enrich(city, nodes, ways, relations, source_info):
    latitude = sum(p[0] for b in city["buildings"] for p in b["points"][:1]) / len(city["buildings"])
    longitude = sum(p[1] for b in city["buildings"] for p in b["points"][:1]) / len(city["buildings"])
    lon_scale = 111320 * math.cos(math.radians(latitude))
    project = lambda p: ((p[1] - longitude) * lon_scale, (p[0] - latitude) * 111320)
    geometry, grid, outlines = [], defaultdict(list), defaultdict(list)
    for index, building in enumerate(city["buildings"]):
        # Re-running against the same XML must yield the same JSON, not compound
        # maxima or lose the original normalized attributes.
        previous = building.pop("buildingParts", None)
        if previous:
            for key in ("height", "levels", "heightSource"):
                building[key] = previous["original"][key]
        outer = [project(p) for p in building["points"]]
        min_x, max_x = min(p[0] for p in outer), max(p[0] for p in outer)
        min_y, max_y = min(p[1] for p in outer), max(p[1] for p in outer)
        geometry.append({"outer": outer, "holes": [[project(p) for p in h] for h in building.get("holes", [])],
                         "bounds": (min_x, min_y, max_x, max_y), "area": max(1, area(outer) - sum(area([project(p) for p in h]) for h in building.get("holes", []) if all(inside(project(point), outer) or boundary_distance(project(point), outer) <= 1 for point in h)))})
        for x in range(math.floor((min_x - 1) / CELL_METERS), math.floor((max_x + 1) / CELL_METERS) + 1):
            for y in range(math.floor((min_y - 1) / CELL_METERS), math.floor((max_y + 1) / CELL_METERS) + 1):
                grid[x, y].append(index)
        outlines[building["osmId"]].append(index)
    explicit = defaultdict(set)
    for relation in relations.values():
        if relation["tags"].get("type") != "building":
            continue
        parents = [f'{m["type"]}/{m["ref"]}' for m in relation["members"] if m.get("role") == "outline"]
        for m in relation["members"]:
            if m.get("role") == "part":
                for parent in parents:
                    explicit[f'{m["type"]}/{m["ref"]}'].update(outlines[parent])
    parts = []
    for kind, elements in (("way", ways), ("relation", relations)):
        for identity, element in elements.items():
            tags = element["tags"]
            if tags.get("building:part") in (None, "no"):
                continue
            if kind == "way":
                node_rings = [element["nodes"]]
            else:
                node_rings = rings([m for m in element["members"] if m.get("role") in ("", "outer")], ways)
            for ids in node_rings:
                if len(ids) < 4 or ids[0] != ids[-1] or any(n not in nodes for n in ids):
                    continue
                coords = [project(nodes[n]) for n in ids[:-1]]
                levels = number(tags.get("building:levels"))
                height, height_source = body_height(tags)
                inner = [] if kind == "way" else [[project(nodes[n]) for n in ring[:-1]] for ring in rings([m for m in element["members"] if m.get("role") == "inner"], ways) if all(n in nodes for n in ring)]
                parts.append({"osmId": f"{kind}/{identity}", "ring": coords, "holes": inner, "area": max(0, area(coords) - sum(area(h) for h in inner if all(inside(point, coords) or boundary_distance(point, coords) <= 1 for point in h))),
                              "levels": levels, "height": height, "heightSource": height_source,
                              "eavesSource": "height-minus-roof:height" if height_source == "OSM" and number(tags.get("roof:height"), zero=True) is not None else "flat-height" if height_source == "OSM" else "building:levels-times-3.3",
                              "recordedHeight": number(tags.get("height")), "roofHeight": number(tags.get("roof:height"), zero=True),
                              "tags": {k: tags[k] for k in TAG_KEYS if k in tags}})
    assigned = defaultdict(dict)
    numeric_parts = 0
    for part in parts:
        if part["height"] is None:
            continue
        numeric_parts += 1
        candidates = explicit[part["osmId"]]
        if not candidates:
            ring = part["ring"]
            px, py = ring[0]
            candidates = [i for i in grid[math.floor(px / CELL_METERS), math.floor(py / CELL_METERS)]
                          if city["buildings"][i]["osmId"] != part["osmId"] and covered(ring, geometry[i])]
        if not candidates:
            continue
        parent = min(candidates, key=lambda i: (geometry[i]["area"], city["buildings"][i]["osmId"]))
        assigned[parent][part["osmId"]] = part
    changed, height_updates, level_updates, report = 0, 0, 0, []
    rejected, safe_bodies = [], 0
    for index, found in assigned.items():
        building = city["buildings"][index]
        principal = [p for p in found.values() if p["area"] >= geometry[index]["area"] * 0.05]
        samples = footprint_samples(geometry[index])
        coverage = (sum(any(inside(point, p["ring"]) and not any(inside(point, hole) for hole in p["holes"]) for p in principal) for point in samples) / len(samples)) if samples else 0
        heights = [p["height"] for p in principal]
        tagged_levels = [p["levels"] for p in principal if p["levels"] is not None]
        height_span = max(heights) - min(heights) if heights else math.inf
        level_span = max(tagged_levels) - min(tagged_levels) if tagged_levels else 0
        if coverage < 0.60 or height_span > 3.3 + 1e-8 or level_span > 1:
            rejected.append({"osmId": building["osmId"], "name": building.get("name", ""), "coverage": round(coverage, 3), "eavesSpan": round(height_span, 2) if heights else None, "levelsSpan": level_span})
            continue
        safe_bodies += 1
        candidates = []
        for p in sorted(principal, key=lambda p: p["osmId"]):
            candidate = {k: v for k, v in p.items() if k not in ("ring", "holes", "area")}
            candidate["footprintCoverage"] = round(sum(inside(point, p["ring"]) and not any(inside(point, h) for h in p["holes"]) for point in samples) / len(samples), 3)
            candidates.append(candidate)
        tallest = max(candidates, key=lambda p: (p["height"], p["heightSource"] == "OSM", p["footprintCoverage"], p["osmId"]))
        with_levels = [p for p in candidates if p["levels"] is not None]
        most_levels = max(with_levels, key=lambda p: (p["levels"], p["osmId"])) if with_levels else None
        height = round(max(building["height"], tallest["height"]), 1)
        levels = max(building["levels"], most_levels["levels"] if most_levels else building["levels"])
        if height == building["height"] and levels == building["levels"]:
            continue
        original_tags = (ways.get(building["osmId"].split("/")[1]) if building["osmId"].startswith("way/")
                         else relations.get(building["osmId"].split("/")[1])) or {"tags": {}}
        original = {k: building[k] for k in ("height", "levels", "heightSource")}
        original["osmTags"] = {k: original_tags["tags"][k] for k in ("height", "building:levels") if k in original_tags["tags"]}
        height_changed, levels_changed = height > building["height"], levels > building["levels"]
        if height_changed:
            building["heightSource"] = tallest["heightSource"]
        building["height"], building["levels"] = height, levels
        building["buildingParts"] = {"original": original, "heightPart": tallest["osmId"] if height_changed else None,
                                    "levelsPart": most_levels["osmId"] if levels_changed else None, "coverage": round(coverage, 3), "eavesSpan": round(height_span, 3),
                                    "heightInterpretation": "eaves", "eavesSource": tallest["eavesSource"] if height_changed else "original-outline-height",
                                    "roofHeight": tallest["roofHeight"] if height_changed else None, "parts": candidates}
        changed += 1
        height_updates += height_changed
        level_updates += levels_changed
        report.append({"osmId": building["osmId"], "name": building.get("name", ""),
                       "original": original, "height": height, "levels": levels,
                       "heightSource": building["heightSource"], "parts": len(candidates)})
    summary = {"sourceParts": len({p["osmId"] for p in parts}), "numericParts": numeric_parts,
               "assignedParts": sum(len(p) for p in assigned.values()), "updatedBuildings": changed,
               "heightUpdates": height_updates, "levelUpdates": level_updates, "safeBodies": safe_bodies, "ambiguousBodiesRejected": len(rejected)}
    city["buildingPartsEnrichment"] = {**summary, "sources": source_info,
        "method": "Ground-contact body parts covering at least 60% of the footprint, with principal eaves spanning at most 3.3 m and recorded levels spanning at most one floor. Eaves use height minus roof:height, flat recorded height, or the existing 3.3 m/level conversion.",
        "limitations": "Footprints and counts are unchanged. Coherent principal bodies produce one coarse extrusion, not individual 3D parts. Roof-only, elevated and small tower parts are ignored; ambiguous complexes are untouched. Original attributes and exact source tags are preserved per changed building. Without recorded roof height, pitched parts require recorded levels and retain the existing 3.3 m/level conversion."}
    return summary, sorted(report, key=lambda b: b["osmId"]), rejected


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--city", type=Path, default=Path("public/data/city.json"))
    outputs = parser.add_mutually_exclusive_group()
    outputs.add_argument("--in-place", action="store_true")
    outputs.add_argument("--output", type=Path)
    parser.add_argument("--report", type=Path, help="Optional detailed JSON change report")
    parser.add_argument("sources", nargs="+", type=Path, help="Cached OSM XML files")
    args = parser.parse_args()
    source_paths = sorted(set(path.resolve() for path in args.sources), key=str)
    source_info = [{"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in source_paths]
    city = json.loads(args.city.read_text())
    original_footprints = [(b["osmId"], b["points"], b.get("holes")) for b in city["buildings"]]
    nodes, ways, relations = load_sources(source_paths)
    summary, report, rejected = enrich(city, nodes, ways, relations, source_info)
    assert original_footprints == [(b["osmId"], b["points"], b.get("holes")) for b in city["buildings"]]
    assert all(b["heightSource"] in ("OSM", "levels", "default") for b in city["buildings"])
    destination = args.city if args.in_place else args.output
    if destination:
        destination.write_text(json.dumps(city, ensure_ascii=False, separators=(",", ":")) + "\n")
    if args.report:
        args.report.write_text(json.dumps({"summary": summary, "buildings": report, "rejectedAmbiguousBodies": rejected}, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"summary": summary, "namedChanges": [b for b in report if b["name"]],
                      "written": str(destination) if destination else None}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
