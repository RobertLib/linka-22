#!/usr/bin/env python3
"""Download only the line 22 corridor from IPR Prague's public MTVU polygons.

Network preparation:
  python3 scripts/download-street-surfaces.py --cache-dir /private/tmp/linka-ipr-streets --download
Offline reproduction from the resulting cache (requires Shapely 2):
  python3 scripts/download-street-surfaces.py --cache-dir /private/tmp/linka-ipr-streets

Local source polygon vertices and holes are retained; oversized source
polygons are clipped at the 100 m corridor boundary, whose artificial edges
are marked. ArcGIS transforms S-JTSK to WGS84; output is not simplified or
rounded. This is an archived technical-map
source, not an assertion that every curb is unchanged in October 2026.
"""

import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    import shapely
    from shapely.geometry import LineString, Point, Polygon
    from shapely.strtree import STRtree
    from shapely.validation import make_valid
except ImportError:
    raise SystemExit("Source preparation requires Shapely 2: python3 -m pip install shapely")


LAYER_URL = "https://gs-pub.praha.eu/arcgis/rest/services/dtmp/dtmp/MapServer/15"
RULES_URL = "https://geoportalpraha.cz/backend/getdokument/1"
KINDS = {700: "paved", 701: "road", 702: "sidewalk", 703: "cycleway", 704: "parking", 705: "tram", 1003: "paved"}
FIELDS = "OBJECTID,ID,CTVUK_KOD,CTVUK_POPIS,DAT_VZNIK,DAT_ZMENA,POSKYT,ID_POSKYT,PLOCHA"


def inside(point, ring):
    hit = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > point[1]) != (b[1] > point[1]) and point[0] < (
            (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]
        ):
            hit = not hit
    return hit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--date", default="2026-10-14", help="client-facing download date")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    route = json.loads((root / "public/data/route22.json").read_text())
    origin = route["origin"]
    scale_x = 111320 * math.cos(math.radians(origin["lat"]))
    project = lambda p: ((p[1] - origin["lon"]) * scale_x, (p[0] - origin["lat"]) * 111320)
    points = [[p["lat"], p["lon"]] for p in route["points"]]
    stations = [p["distance"] for p in route["points"]]
    length = stations[-1]

    def at(station):
        i = min(len(points) - 2, max(0, bisect_right(stations, station) - 1))
        t = (station - stations[i]) / (stations[i + 1] - stations[i] or 1)
        return [points[i][j] + (points[i + 1][j] - points[i][j]) * t for j in (0, 1)]

    args.cache_dir.mkdir(parents=True, exist_ok=True)
    sources = []

    def cached(name, url):
        output = args.cache_dir / name
        if args.download and not output.exists():
            for attempt in range(4):
                try:
                    request = Request(url, headers={"User-Agent": "Linka22 source preparation (public IPR corridor data)"})
                    with urlopen(request, timeout=60) as response:
                        data = response.read()
                    if not name.endswith(".pdf"):
                        parsed = json.loads(data)
                        if "error" in parsed:
                            raise RuntimeError(parsed["error"])
                    output.write_bytes(data)
                    break
                except Exception:
                    if attempt == 3:
                        raise
                    time.sleep(attempt + 1)
        if not output.exists():
            raise SystemExit(f"Cache missing {output}; prepare it with --download first")
        data = output.read_bytes()
        source = {"file": name, "url": url, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        return (data, source)

    data, source = cached("ipr-layer.json", LAYER_URL + "?f=json")
    metadata = json.loads(data)
    sources.append(source)
    _, source = cached("ipr-reuse-rules.pdf", RULES_URL)
    sources.append(source)

    # Request IDs in short geographic envelopes first, then download each
    # unique object once. No request is made for all of Prague.
    requests, envelopes = [], []
    for number, start in enumerate(range(0, math.ceil(length), 800)):
        end = min(length, start + 800)
        selected = [at(start), at(end)] + [p for p, s in zip(points, stations) if start < s < end]
        envelope = [min(p[1] for p in selected) - 180 / scale_x,
                    min(p[0] for p in selected) - 180 / 111320,
                    max(p[1] for p in selected) + 180 / scale_x,
                    max(p[0] for p in selected) + 180 / 111320]
        envelopes.append({"from": start, "to": end, "bounds": envelope})
        params = {"f": "json", "where": "CTVUK_KOD IN (" + ",".join(map(str, KINDS)) + ")",
                  "geometry": ",".join(map(str, envelope)), "geometryType": "esriGeometryEnvelope",
                  "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "returnIdsOnly": "true"}
        requests.append((f"ipr-ids-{number:02d}.json", LAYER_URL + "/query?" + urlencode(params)))
    object_ids = set()
    with ThreadPoolExecutor(max_workers=4) as pool:
        for (data, source) in pool.map(lambda pair: cached(*pair), requests):
            item = json.loads(data)
            if item.get("exceededTransferLimit"):
                raise SystemExit("ArcGIS truncated an ID query; refusing incomplete source data")
            object_ids.update(item.get("objectIds") or [])
            sources.append(source)
    print(f"Selected {len(object_ids)} unique source polygons in {len(envelopes)} corridor envelopes", flush=True)

    identities = sorted(object_ids)
    requests = []
    for number, start in enumerate(range(0, len(identities), 150)):
        params = {"f": "geojson", "objectIds": ",".join(map(str, identities[start:start + 150])),
                  "outFields": FIELDS, "returnGeometry": "true", "outSR": 4326,
                  "returnZ": "false", "returnM": "false", "orderByFields": "OBJECTID ASC"}
        requests.append((f"ipr-polygons-{number:02d}.geojson", LAYER_URL + "/query?" + urlencode(params)))
    raw = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for (data, source) in pool.map(lambda pair: cached(*pair), requests):
            batch = json.loads(data)
            if batch.get("exceededTransferLimit"):
                raise SystemExit("ArcGIS truncated a geometry query; refusing incomplete source data")
            for item in batch["features"]:
                raw[item["properties"]["OBJECTID"]] = item
            sources.append(source)
    if set(raw) != object_ids:
        raise SystemExit("Geometry export is missing selected source objects")

    route_xy = [project(p) for p in points]
    segments = list(zip(route_xy, route_xy[1:]))
    grid, cell_size = defaultdict(list), 250
    for i, (a, b) in enumerate(segments):
        for x in range(math.floor((min(a[0], b[0]) - 140) / cell_size), math.floor((max(a[0], b[0]) + 140) / cell_size) + 1):
            for y in range(math.floor((min(a[1], b[1]) - 140) / cell_size), math.floor((max(a[1], b[1]) + 140) / cell_size) + 1):
                grid[x, y].append(i)

    def distance(point):
        x, y = project(point)
        best = math.inf
        for i in grid[math.floor(x / cell_size), math.floor(y / cell_size)]:
            a, b = segments[i]
            dx, dy = b[0] - a[0], b[1] - a[1]
            t = max(0, min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy or 1)))
            best = min(best, math.hypot(x - a[0] - dx * t, y - a[1] - dy * t))
        return best

    samples = [(s, at(s)) for s in range(0, math.ceil(length), 10)] + [(length, at(length))]

    def contains(point, outer, holes):
        return inside([point[1], point[0]], outer) and not any(inside([point[1], point[0]], hole) for hole in holes)

    def near(outer, holes):
        if any(distance([p[1], p[0]]) <= 100 for p in outer):
            return True
        for a, b in zip(outer, outer[1:]):
            n = math.ceil(math.hypot((b[0] - a[0]) * scale_x, (b[1] - a[1]) * 111320) / 20)
            for i in range(1, n):
                t = i / n
                if distance([a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t]) <= 100:
                    return True
        return any(contains(p, outer, holes) for _, p in samples)

    corridor = LineString(route_xy).buffer(100, quad_segs=16)
    clip_boundary = corridor.boundary
    features, feature_shapes, repaired_ids = [], [], []

    def polygon_parts(geometry):
        if geometry.geom_type == "Polygon":
            yield geometry
        elif hasattr(geometry, "geoms"):
            for child in geometry.geoms:
                yield from polygon_parts(child)

    for identity in sorted(raw):
        item = raw[identity]
        geometry, attributes = item["geometry"], item["properties"]
        if geometry["type"] == "Polygon":
            polygons = [geometry["coordinates"]]
        elif geometry["type"] == "MultiPolygon":
            polygons = geometry["coordinates"]
        else:
            raise SystemExit(f"Unsupported geometry for source object {identity}")
        part = 0
        for polygon in polygons:
            outer, holes = polygon[0], polygon[1:]
            if not near(outer, holes):
                continue
            source_coordinates = {project([p[1], p[0]]): [p[1], p[0]] for ring in polygon for p in ring}
            shape = Polygon([project([p[1], p[0]]) for p in outer],
                            [[project([p[1], p[0]]) for p in h] for h in holes])
            if not shape.is_valid:
                shape = make_valid(shape)
                repaired_ids.append(identity)
            clipped = shape.intersection(corridor)
            was_clipped = not shape.covered_by(corridor)

            def ring_data(ring):
                xy = list(ring.coords)
                ps = [source_coordinates.get(tuple(p)) or
                      [origin["lat"] + p[1] / 111320, origin["lon"] + p[0] / scale_x] for p in xy]
                artificial = [i for i, (a, b) in enumerate(zip(xy, xy[1:]))
                              if clip_boundary.distance(Point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) < 1e-5]
                return ps, artificial

            for piece in polygon_parts(clipped):
                if piece.area < 0.02:
                    continue
                ps, cut_edges = ring_data(piece.exterior)
                hole_data = [ring_data(ring) for ring in piece.interiors]
                features.append({"id": f"ipr/{identity}/{part}", "objectId": identity,
                                 "kind": KINDS[attributes["CTVUK_KOD"]], "code": attributes["CTVUK_KOD"],
                                 "points": ps, "holes": [ps for ps, _ in hole_data],
                                 "clipped": was_clipped, "clipEdges": cut_edges,
                                 "clipHoleEdges": [indices for _, indices in hole_data],
                                 "attributes": attributes})
                feature_shapes.append(piece)
                part += 1

    # Coverage describes observed source polygons, rather than pretending
    # an unclassified or missing source interval is an accurately mapped curb.
    sample_counts, missing = Counter(), []
    tree = STRtree(feature_shapes)
    for station, p in samples:
        sample = Point(project(p))
        found = [features[i] for i in tree.query(sample, predicate="intersects")]
        kinds = set(f["kind"] for f in found)
        sample_counts.update(kinds)
        if not kinds.intersection({"road", "tram", "paved"}):
            missing.append(station)
    intervals = []
    for station in missing:
        if intervals and station - intervals[-1]["to"] <= 10.001:
            intervals[-1]["to"] = station
        else:
            intervals.append({"from": station, "to": station})
    dates = sorted({a for f in features for a in (f["attributes"].get("DAT_VZNIK"), f["attributes"].get("DAT_ZMENA")) if a})
    result = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "rulesUrl": RULES_URL, "sourceUrl": LAYER_URL, "downloadDate": args.date,
        "sourceName": metadata["name"],
        "sourceSpatialReference": metadata.get("sourceSpatialReference"),
        "outputSpatialReference": "EPSG:4326; coordinates ordered [latitude, longitude]",
        "geometrySimplificationMeters": 0,
        "changes": "Selected categories and 100 m corridor; ArcGIS transformed geometry to WGS84; clipped source polygons to the corridor and marked artificial cut edges; split multipart outlines; original local vertices retained without rounding or simplification.",
        "processing": {"shapely": shapely.__version__, "clippingCorridorMeters": 100,
                       "artificialBoundary": "clipEdges/clipHoleEdges index source rings' artificial corridor-boundary segments; never render these as real curbs",
                       "repairedInvalidSourceObjects": sorted(set(repaired_ids))},
        "limitations": [
            "Archived DTMP/MTVU geometry describes the earlier technical-map source, with object dates retained. It is not verified against every 2026 street reconstruction.",
            "CTVUK_KOD identifies physical use, not legal motor access or asphalt/paving material. Road access and material still use OSM metadata where available.",
            "Coordinate storage precision and xyTolerance are not survey accuracy guarantees. Source curved boundaries are linearized by the ArcGIS GeoJSON exporter.",
            "Polygons lack heights and bridge/tunnel level metadata; overlapping levels require the scene's existing bridge and terrain model.",
            "Source polygons are trimmed at the 100 m route corridor. Artificial clip edges are marked separately and are not real curbs. Missing intervals are recorded; absence is not proof of grass.",
        ],
        "sources": sources,
        "features": features,
        "counts": {"features": len(features), "objects": len({f["objectId"] for f in features}),
                   "vertices": sum(len(f["points"]) + sum(map(len, f["holes"])) for f in features),
                   "holes": sum(len(f["holes"]) for f in features),
                   "artificialClipEdges": sum(len(f["clipEdges"]) + sum(map(len, f["clipHoleEdges"])) for f in features),
                   "byKind": dict(sorted(Counter(f["kind"] for f in features).items()))},
        "coverage": {"corridorMeters": 100, "queryMarginMeters": 180, "queryEnvelopes": envelopes,
                     "routeSampleSpacingMeters": 10, "routeSamples": len(samples),
                     "routeSamplesWithRoadTramOrPaved": len(samples) - len(missing),
                     "routeSamplesByKind": dict(sorted(sample_counts.items())),
                     "routeCoveragePercent": round(100 * (len(samples) - len(missing)) / len(samples), 3),
                     "missingRoadTramIntervals": intervals},
        "sourceObjectDates": {"earliest": dates[0] if dates else None, "latest": dates[-1] if dates else None},
    }
    output = args.output or root / "public/data/street-surfaces.json"
    output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps(result["counts"], ensure_ascii=False), flush=True)
    print(f"Route polygon coverage {result['coverage']['routeCoveragePercent']}%; {len(intervals)} missing source intervals. Wrote {output.stat().st_size:,} bytes", flush=True)


if __name__ == "__main__":
    main()
