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
