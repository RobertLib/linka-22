#!/usr/bin/env python3
"""Extract IPR Praha photogrammetric bridges visible from line 22.

"Mosty 3D / Bridges 3D model" of IPR Praha (CC BY 4.0, datový podklad © IPR
Praha) models all Prague bridges as 3D faces in S-JTSK with Bpv heights. This
keeps every bridge with a face within --distance metres of the PID route and
stores its triangulated faces in the scene frame. The runtime omits the deck
faces carrying the line itself, whose surfaces come from the street survey.

  python3 scripts/import-ipr-bridges.py --archive /path/to/mosty_shp.zip \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif --output public/data/bridges-3d.json
"""

import argparse
import base64
from collections import defaultdict
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

import numpy as np
from shapely.geometry import LineString, box

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import Projection, open_shapefile, sha256_file  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "linka_ipr_buildings", Path(__file__).resolve().parent / "import-ipr-buildings.py")
buildings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(buildings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data/bridges-3d.json"))
    parser.add_argument("--lidar", type=Path, default=Path("public/data/terrain-lidar.json"))
    parser.add_argument("--distance", type=float, default=1200)
    parser.add_argument("--catalogue", default="https://opendata.geoportalpraha.cz/maps/iprpraha::mosty-3d-bridges-3d-model")
    parser.add_argument("--url", default="https://www.arcgis.com/sharing/rest/content/items/622e66a29f3d459a8dbc57939954db8c/data")
    args = parser.parse_args()
    route = json.loads(args.route.read_text("utf-8"))
    projection = Projection(route, args.grid)
    origin, baseline = route["origin"], route["baselineAltitude"]
    line = LineString(buildings.world_ring([(p["lat"], p["lon"]) for p in route["points"]], origin,
                                           math.cos(math.radians(origin["lat"]))))
    corridor = line.buffer(args.distance)
    reader = open_shapefile(args.archive)
    shapes, records = [], []
    fields = [field[0] for field in reader.fields[1:]]
    for item in reader.iterShapeRecords():
        if item.shape.points:
            shapes.append(item.shape)
            records.append(dict(zip(fields, item.record)))
    counts = [len(shape.points) for shape in shapes]
    native = np.concatenate([np.asarray(shape.points) for shape in shapes])
    heights = np.concatenate([np.asarray(shape.z) for shape in shapes])
    wx, wz = projection.native_to_world(native[:, 0], native[:, 1])
    world = np.column_stack([wx, heights - baseline, wz])
    offsets = np.concatenate([[0], np.cumsum(counts)])
    faces = defaultdict(list)
    near_bridges = set()
    for shape, record, start, end in zip(shapes, records, offsets[:-1], offsets[1:]):
        xyz = world[start:end]
        faces[record["ID_BUD"]].append((shape, xyz, record))
        if corridor.intersects(box(xyz[:, 0].min(), xyz[:, 2].min(), xyz[:, 0].max(), xyz[:, 2].max())):
            near_bridges.add(record["ID_BUD"])
    # The line's own bridge: spans over water without a measured intrados
    # (the IPR model draws a flat slab there) get segmental arches shaped like
    # the measured arches of the same bridge.
    profile = np.array(route.get("profile") or [], dtype=float)
    lidar = json.loads(args.lidar.read_text("utf-8")) if args.lidar.exists() else None
    axis_pts = np.array(buildings.world_ring([(p["lat"], p["lon"]) for p in route["points"]], origin,
                                             math.cos(math.radians(origin["lat"]))))
    axis_s = np.array([p["distance"] for p in route["points"]])

    def frame(x, z):
        d = np.hypot(axis_pts[:, 0] - x, axis_pts[:, 1] - z)
        i = int(np.argmin(d))
        best = None
        for a in (i - 1, i):
            if a < 0 or a + 1 >= len(axis_pts):
                continue
            p0, seg = axis_pts[a], axis_pts[a + 1] - axis_pts[a]
            t = float(np.clip(((x - p0[0]) * seg[0] + (z - p0[1]) * seg[1]) / max(seg @ seg, 1e-9), 0, 1))
            foot = p0 + seg * t
            lateral = (x - foot[0]) * -seg[1] / np.linalg.norm(seg) + (z - foot[1]) * seg[0] / np.linalg.norm(seg)
            if best is None or abs(lateral) < abs(best[1]):
                best = (axis_s[a] + (axis_s[a + 1] - axis_s[a]) * t, lateral)
        return best

    def point_at(s, lateral):
        i = int(np.clip(np.searchsorted(axis_s, s) - 1, 0, len(axis_s) - 2))
        t = (s - axis_s[i]) / max(axis_s[i + 1] - axis_s[i], 1e-9)
        p0, seg = axis_pts[i], axis_pts[i + 1] - axis_pts[i]
        normal = np.array([-seg[1], seg[0]]) / np.linalg.norm(seg)
        p = p0 + seg * t + normal * lateral
        return float(p[0]), float(p[1])

    def ground_at(x, z):
        if not lidar:
            return math.nan
        size = lidar["tileSize"]
        tile = next((t for t in lidar["tiles"] if t["x"] == math.floor(x / size) and t["z"] == math.floor(z / size)), None)
        if tile is None:
            return math.nan
        values = np.cumsum(np.frombuffer(base64.b64decode(tile["data"]), dtype="<u2").astype(np.int64)) & 0xFFFF
        grid = (values / 100.0).reshape(tile["n"], tile["n"])
        i = int(round((x - tile["x"] * size) / tile["step"]))
        j = int(round((z - tile["z"] * size) / tile["step"]))
        return float(grid[min(j, tile["n"] - 1), min(i, tile["n"] - 1)]) - baseline

    reconstructed = {}

    def reconstruct_arches(bridge_id, xyz_faces):
        if len(profile) == 0:
            return []
        vertices = np.concatenate([xyz for _, xyz, _ in xyz_faces])
        framed = np.array([(*frame(x, z), y) for x, y, z in vertices])
        on_line = np.abs(framed[:, 1]) < 9
        if on_line.sum() < 50:
            return []
        deck = lambda s: float(np.interp(s, profile[:, 0], profile[:, 1])) - baseline
        sv, lv, yv = framed[on_line, 0], framed[on_line, 1], framed[on_line, 2]
        water = np.nanmin([ground_at(*point_at(s, 0)) for s in np.linspace(sv.min(), sv.max(), 40)])
        piers = np.sort(sv[yv < water - 1.0])
        if not len(piers):
            return []
        supports, current = [], [piers[0], piers[0]]
        for s_ in piers[1:]:
            if s_ - current[1] > 5:
                supports.append(current)
                current = [s_, s_]
            else:
                current[1] = s_
        supports.append(current)
        supports = [[sv.min(), sv.min()]] + supports + [[sv.max(), sv.max()]]
        spans = [(a[1], b[0]) for a, b in zip(supports, supports[1:]) if b[0] - a[1] >= 15]
        measured, missing = [], []
        for a, b in spans:
            length = b - a
            middle = (sv > a + 0.25 * length) & (sv < b - 0.25 * length)
            # A modelled span has vertices of its arch ring between the piers;
            # the flat-slab spans of the model consist only of pier-to-pier
            # triangles with no vertex in their middle.
            intrados = middle & (yv > water + 0.5)
            below = [ground_at(*point_at(a + length * f, 0)) for f in np.linspace(0.1, 0.9, 9)]
            over_water = np.mean([g < water + 1.5 for g in below]) >= 0.5
            if intrados.sum() >= 2:
                springing = yv[(sv > a) & (sv < a + 0.15 * length) & (yv > water + 0.5)]
                crown = yv[intrados & (yv < np.array([deck(x) for x in sv]) - 0.2)]
                if len(springing) and len(crown):
                    measured.append((springing.min() - water, deck((a + b) / 2) - crown.max()))
            elif over_water:
                missing.append((a, b))
        if not measured or not missing:
            return []
        rise_above_water = float(np.median([m[0] for m in measured]))
        crown_depth = float(np.median([m[1] for m in measured]))
        half = float(np.percentile(np.abs(lv), 95))
        faces = []
        for a, b in missing:
            a, b = a + 0.3, b - 0.3
            springing = water + rise_above_water
            stations = np.linspace(a, b, 25)
            crown = deck((a + b) / 2) - crown_depth
            # Circular segment through both springings and the crown.
            half_span = (b - a) / 2
            rise = max(0.5, crown - springing)
            radius = (half_span ** 2 + rise ** 2) / (2 * rise)
            centre = crown - radius
            curve = [centre + math.sqrt(max(radius ** 2 - (s_ - (a + b) / 2) ** 2, 0)) for s_ in stations]
            for s0, s1, y0, y1 in zip(stations, stations[1:], curve, curve[1:]):
                l0, r0 = point_at(s0, -half), point_at(s0, half)
                l1, r1 = point_at(s1, -half), point_at(s1, half)
                faces.append(np.array([[l0[0], y0, l0[1]], [l1[0], y1, l1[1]], [r1[0], y1, r1[1]], [r0[0], y0, r0[1]]]))
                for side in (-half, half):
                    p0, p1 = point_at(s0, side), point_at(s1, side)
                    t0, t1 = deck(s0) - 0.6, deck(s1) - 0.6
                    faces.append(np.array([[p0[0], y0, p0[1]], [p1[0], y1, p1[1]], [p1[0], t1, p1[1]], [p0[0], t0, p0[1]]]))
        reconstructed[bridge_id] = {
            "spans": [[round(a, 1), round(b, 1)] for a, b in missing],
            "springingAboveWater": round(rise_above_water, 2),
            "crownBelowDeck": round(crown_depth, 2),
            "measuredArches": len(measured),
            "halfWidth": round(half, 2),
        }
        return faces

    output, positions, indices = [], [], []
    for bridge_id in sorted(near_bridges):
        vertex_start = len(positions) // 3
        shared, triangles = {}, []
        for shape, xyz, record in faces[bridge_id]:
            parts = list(shape.parts) + [len(shape.points)]
            rings = []
            for a, b in zip(parts[:-1], parts[1:]):
                ring = xyz[a:b]
                if len(ring) > 1 and np.allclose(ring[0], ring[-1]):
                    ring = ring[:-1]
                if len(ring) >= 3:
                    rings.append(ring)
            if not rings:
                continue
            vertices, local = buildings.triangulate(rings)
            if vertices is None:
                continue
            mapped = []
            for x, y, z in vertices:
                key = (int(round(x * 100)), int(round(y * 100)), int(round(z * 100)))
                if key not in shared:
                    shared[key] = len(positions) // 3 - vertex_start
                    positions += key
                mapped.append(shared[key])
            mapped = np.asarray(mapped)[local]
            keep = (mapped[:, 0] != mapped[:, 1]) & (mapped[:, 1] != mapped[:, 2]) & (mapped[:, 0] != mapped[:, 2])
            triangles += mapped[keep].ravel().tolist()
        for face in reconstruct_arches(bridge_id, faces[bridge_id]):
            vertices, local = buildings.triangulate([face])
            if vertices is None:
                continue
            mapped = []
            for x, y, z in vertices:
                key = (int(round(x * 100)), int(round(y * 100)), int(round(z * 100)))
                if key not in shared:
                    shared[key] = len(positions) // 3 - vertex_start
                    positions += key
                mapped.append(shared[key])
            triangles += np.asarray(mapped)[local].ravel().tolist()
        vertex_count = len(positions) // 3 - vertex_start
        if not triangles or vertex_count > 65535:
            continue
        output.append({
            "id": int(bridge_id),
            "updated": max(record["AKTUALIZAC"] for _, _, record in faces[bridge_id]),
            "vertexStart": vertex_start,
            "vertexCount": vertex_count,
            "indexStart": len(indices),
            "indexCount": len(triangles),
        })
        indices += triangles
    positions = np.asarray(positions, dtype=np.int64).reshape(-1, 3)
    deltas = positions.copy()
    for item in output:
        a, b = item["vertexStart"], item["vertexStart"] + item["vertexCount"]
        deltas[a + 1:b] = positions[a + 1:b] - positions[a:b - 1]
    result = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "source": {"title": "Mosty 3D / Bridges 3D model", "catalogue": args.catalogue, "url": args.url,
                   "archiveSha256": sha256_file(args.archive)},
        "coordinateTransform": projection.metadata,
        "origin": origin,
        "baselineAltitude": baseline,
        "selection": f"Bridges with a face within {args.distance:g} m of the PID shape",
        "encoding": "As buildings-3d.json: Int32 cm deltas per bridge, Uint16 local indices, base64",
        "reconstructedArches": {str(k): v for k, v in reconstructed.items()},
        "reconstructionNote": "Spans of the line's bridge over water whose IPR model has no intrados get "
                              "segmental arches with the springing height and crown depth measured on the "
                              "same bridge's modelled arches; deck heights from the route profile.",
        "bridges": output,
        "positions": base64.b64encode(deltas.astype("<i4").tobytes()).decode("ascii"),
        "indices": base64.b64encode(np.asarray(indices, dtype="<u2").tobytes()).decode("ascii"),
    }
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    args.output.write_text(text + "\n", "utf-8")
    print(json.dumps({"bridges": len(output), "vertices": int(len(positions)), "triangles": len(indices) // 3,
                      "bytes": len(text), "sha256": hashlib.sha256(text.encode()).hexdigest()}))


if __name__ == "__main__":
    main()
