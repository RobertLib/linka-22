#!/usr/bin/env python3
"""Attach IPR Praha photogrammetric roofs and eaves to the scene's buildings.

"Budovy 3D" of IPR Praha models every building as 3D faces: roofs (Strecha),
walls (Stena), roof details such as chimneys, dormers and towers (Detail) and
foundation slabs (Zakladova deska). Roofs were evaluated stereo-
photogrammetrically to at least 0.5 m; walls were derived from the roof model.

The scene keeps OSM footprints for its facades. For every OSM building near
the line this importer stores:

* the real ground, eaves and ridge altitude,
* the measured wall-top profile along each footprint edge (the roof height
  where the wall meets it, including gables, steps and dormers in the facade),
* the photogrammetric roof mesh with its details and the walls that rise
  from the roof (towers, setbacks, firewalls inside the footprint).

Roof faces are assigned to the OSM footprint containing them, so roofs of
buildings demolished since the survey (no current OSM footprint) are dropped.
OSM buildings without enough measured roof keep the procedural roof.

  python3 scripts/import-ipr-buildings.py --cache-dir /private/tmp/linka-ipr-3d \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif --output public/data/buildings-3d.json
"""

import argparse
import base64
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import sys

import mapbox_earcut as earcut
import numpy as np
from shapely import STRtree, points as shapely_points
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import Projection, open_shapefile, sha256_file, verified_archives  # noqa: E402

CORRIDOR = 320          # metres from the route; matches the detailed scene
COVERAGE = 0.6          # share of a footprint that must carry measured roof
FACADE_BAND = 0.9       # a wall face this close to the footprint outline is the facade
ASSIGN_DISTANCE = 1.6   # roof overhang allowed beyond an OSM outline
PROFILE_STEP = 1.5      # wall-top samples along each footprint edge
INWARD_PROBES = (0.0, 0.3, 0.7, 1.2, 1.8)
ROOF_NORMAL = 0.25      # |n_y| above this is a roof-like surface


def world_ring(points, origin, cos):
    return [((lon - origin["lon"]) * 111320 * cos, -(lat - origin["lat"]) * 111320) for lat, lon in points]


def plane_normal(xyz):
    """Newell normal of a 3D polygon in world (x, y, z) with y up."""
    n = np.zeros(3)
    for a, b in zip(xyz, np.roll(xyz, -1, axis=0)):
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    length = np.linalg.norm(n)
    return n / length if length > 1e-12 else None


def triangulate(rings, normal=None):
    """Earcut a planar 3D polygon (outer ring plus holes) in its own plane,
    facing `normal` (the source winding is not consistent)."""
    outer = rings[0]
    normal = plane_normal(outer) if normal is None else normal
    if normal is None:
        return None, None
    axis = int(np.argmax(np.abs(normal)))
    keep = [i for i in range(3) if i != axis]
    flat = np.concatenate([ring[:, keep] for ring in rings]).astype(np.float64)
    ends = np.cumsum([len(ring) for ring in rings]).astype(np.uint32)
    triangles = earcut.triangulate_float64(flat, ends)
    if len(triangles) == 0:
        return None, None
    vertices = np.concatenate(rings)
    triangles = triangles.reshape(-1, 3)
    # Orient every triangle along the face normal.
    a, b, c = vertices[triangles[:, 0]], vertices[triangles[:, 1]], vertices[triangles[:, 2]]
    flip = np.einsum("ij,j->i", np.cross(b - a, c - a), normal) < 0
    triangles[flip] = triangles[flip][:, [0, 2, 1]]
    return vertices, triangles


def encode_ints(values, dtype):
    return base64.b64encode(np.asarray(values, dtype=dtype).tobytes()).decode("ascii")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=Path("docs/ipr-3d-manifest.json"))
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--city", type=Path, default=Path("public/data/city.json"))
    parser.add_argument("--context", type=Path, default=Path("public/data/city-context.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data/buildings-3d.json"))
    args = parser.parse_args()
    route = json.loads(args.route.read_text("utf-8"))
    manifest = json.loads(args.manifest.read_text("utf-8"))
    projection = Projection(route, args.grid)
    origin, baseline = route["origin"], route["baselineAltitude"]
    cos = math.cos(math.radians(origin["lat"]))
    line = LineString(world_ring([(p["lat"], p["lon"]) for p in route["points"]], origin, cos))
    corridor = line.buffer(CORRIDOR)

    # Current OSM footprints in the same world frame as src/route.js.
    osm = []
    for source, path in (("city", args.city), ("context", args.context)):
        for building in json.loads(path.read_text("utf-8"))["buildings"]:
            rings = [world_ring(building["points"], origin, cos)]
            rings += [world_ring(hole, origin, cos) for hole in building.get("holes") or []]
            if len(rings[0]) < 4:
                continue
            try:
                polygon = Polygon(rings[0], rings[1:])
                if not polygon.is_valid:
                    polygon = polygon.buffer(0)
            except Exception:
                continue
            if polygon.is_empty or not polygon.intersects(corridor):
                continue
            osm.append({"osmId": building["osmId"], "source": source, "rings": rings,
                        "anchor": [round(building["points"][0][0], 7), round(building["points"][0][1], 7)],
                        "polygon": polygon, "outline": polygon.boundary})
    footprints = STRtree([item["polygon"] for item in osm])
    outlines = STRtree([item["outline"] for item in osm])
    print(f"OSM footprints in corridor: {len(osm)}", flush=True)

    native_corridor = None
    faces = []  # (owner, kind, rings(list of np arrays world x,y,z), iprId, updated)
    slabs = defaultdict(list)
    ipr_buildings_seen = set()
    sheets = []
    for archive in verified_archives(manifest, args.cache_dir, "buildings"):
        reader = open_shapefile(archive)
        if reader.shapeTypeName != "POLYGONZ":
            raise ValueError(f"{archive} is not a POLYGONZ building sheet")
        bx0, by0, bx1, by1 = reader.bbox[:4]
        corner_x, corner_z = projection.native_to_world([bx0, bx1, bx0, bx1], [by0, by0, by1, by1])
        if not box(min(corner_x), min(corner_z), max(corner_x), max(corner_z)).intersects(corridor):
            continue
        fields = [field[0] for field in reader.fields[1:]]
        kept = 0
        shapes, records = [], []
        for shape_record in reader.iterShapeRecords():
            shape = shape_record.shape
            if not shape.points:
                continue
            shapes.append(shape)
            records.append(dict(zip(fields, shape_record.record)))
        # One vectorised transform per sheet.
        counts = [len(shape.points) for shape in shapes]
        native = np.concatenate([np.asarray(shape.points) for shape in shapes])
        heights = np.concatenate([np.asarray(shape.z) for shape in shapes])
        wx, wz = projection.native_to_world(native[:, 0], native[:, 1])
        world = np.column_stack([wx, heights - baseline, wz])
        offsets = np.concatenate([[0], np.cumsum(counts)])
        for shape, record, start, end in zip(shapes, records, offsets[:-1], offsets[1:]):
            xyz = world[start:end]
            kind = record["TYP"].strip()
            ipr_id = int(record["ID_BUD"])
            if kind.startswith("Zaklad"):
                slabs[ipr_id].append(float(xyz[:, 1].min()))
                continue
            minx, maxx = xyz[:, 0].min(), xyz[:, 0].max()
            minz, maxz = xyz[:, 2].min(), xyz[:, 2].max()
            if not corridor.intersects(box(minx, minz, maxx, maxz)):
                continue
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
            faces.append({"kind": kind, "rings": rings, "ipr": ipr_id,
                          "updated": record.get("AKTUALIZAC", "").strip(),
                          "change": record.get("ZMENA", "").strip()})
            ipr_buildings_seen.add(ipr_id)
            kept += 1
        sheets.append({"file": archive.name, "faces": len(shapes), "corridorFaces": kept})
        print(f"{archive.name}: {kept} corridor faces", flush=True)

    # Classify and assign each face to one current OSM footprint.
    owned = defaultdict(list)
    unassigned = defaultdict(int)
    for face in faces:
        outer = face["rings"][0]
        normal = plane_normal(outer)
        if normal is None:
            continue
        face["normal"] = normal
        roof_like = abs(normal[1]) > ROOF_NORMAL
        if face["kind"] == "Stena" or (face["kind"] == "Detail" and not roof_like):
            bottom = outer[:, 1].min()
            low = outer[outer[:, 1] <= bottom + 0.05]
            mid = low[:, [0, 2]].mean(axis=0)
            centre = outer[:, [0, 2]].mean(axis=0)
            probe = Point(*(mid if face["kind"] == "Stena" else centre))
            candidates = outlines.query(probe, predicate="dwithin", distance=FACADE_BAND)
            if face["kind"] == "Stena" and len(candidates):
                unassigned["facade-wall"] += 1  # replaced by the OSM wall with measured top
                continue
            inside = [i for i in footprints.query(probe, predicate="intersects")]
            if not inside:
                unassigned["wall-outside-footprint"] += 1
                continue
            face["class"] = "wall"
            owned[inside[0]].append(face)
            continue
        centroid = Point(*outer[:, [0, 2]].mean(axis=0))
        inside = list(footprints.query(centroid, predicate="intersects"))
        if not inside:
            near = footprints.query(centroid, predicate="dwithin", distance=ASSIGN_DISTANCE)
            if len(near):
                inside = [min(near, key=lambda i: osm[i]["polygon"].distance(centroid))]
        if not inside:
            unassigned[face["kind"]] += 1
            continue
        face["class"] = "roof"
        owned[inside[0]].append(face)

    output_buildings = []
    positions, indices = [], []
    statistics = defaultdict(int)
    for index, building in enumerate(osm):
        mine = owned.get(index, [])
        roofs = [face for face in mine if face["class"] == "roof"]
        # Roofs are seen from above; the photogrammetric winding is arbitrary.
        for face in roofs:
            if face["normal"][1] < 0:
                face["normal"] = -face["normal"]
        if not roofs:
            statistics["withoutMeasuredRoof"] += 1
            continue
        polygon = building["polygon"]
        # Measured roof planes in plan for height sampling and coverage.
        plans, planes = [], []
        for face in roofs:
            outer = face["rings"][0]
            try:
                plan = Polygon(outer[:, [0, 2]])
                if not plan.is_valid:
                    plan = plan.buffer(0)
            except Exception:
                continue
            if plan.is_empty or plan.area < 0.05:
                continue
            n = face["normal"]
            if abs(n[1]) < 1e-6:
                continue
            centre = outer.mean(axis=0)
            plans.append(plan)
            planes.append((n, centre))
        if not plans:
            statistics["withoutMeasuredRoof"] += 1
            continue
        tree = STRtree(plans)
        covered = unary_union(plans).intersection(polygon).area / max(polygon.area, 1e-9)
        if covered < COVERAGE:
            statistics["insufficientCoverage"] += 1
            continue

        def roof_height(x, z):
            hits = tree.query(Point(x, z), predicate="intersects")
            best = None
            for i in hits:
                n, c = planes[i]
                y = c[1] - (n[0] * (x - c[0]) + n[2] * (z - c[2])) / n[1]
                best = y if best is None else max(best, y)
            return best

        ipr_ids = sorted({face["ipr"] for face in mine})
        ground_samples = [value for ipr_id in ipr_ids for value in slabs.get(ipr_id, [])]
        roof_values = np.concatenate([face["rings"][0][:, 1] for face in roofs])
        ridge = float(roof_values.max())
        # Wall-top profile for every footprint edge (outer ring and courtyards).
        profiles = []
        tops = []
        for ring in building["rings"]:
            ring_profile = []
            closed = ring if ring[0] == ring[-1] else ring + [ring[0]]
            ring_poly = Polygon(closed)
            orientation = 1 if ring_poly.exterior.is_ccw else -1
            for (x1, z1), (x2, z2) in zip(closed[:-1], closed[1:]):
                length = math.hypot(x2 - x1, z2 - z1)
                if length < 1e-6:
                    ring_profile.append([])
                    continue
                ux, uz = (x2 - x1) / length, (z2 - z1) / length
                # Inward normal of this edge (into the building mass).
                inward = np.array([-uz, ux]) * orientation
                if not polygon.buffer(-0.05).contains(Point(
                        (x1 + x2) / 2 + inward[0] * 0.2, (z1 + z2) / 2 + inward[1] * 0.2)):
                    inward = -inward
                stations = set(np.linspace(0, 1, max(2, int(math.ceil(length / PROFILE_STEP)) + 1)).round(5))
                # Exact apexes and steps: measured roof vertices next to the edge.
                for plan in tree.query(LineString([(x1, z1), (x2, z2)]).buffer(1.2)):
                    for vx, vz in plans[plan].exterior.coords:
                        t = ((vx - x1) * ux + (vz - z1) * uz) / length
                        offset = abs((vx - x1) * -uz + (vz - z1) * ux)
                        if 0 < t < 1 and offset < 1.2:
                            stations.add(round(t, 5))
                profile = []
                for t in sorted(stations):
                    px, pz = x1 + (x2 - x1) * t, z1 + (z2 - z1) * t
                    y = None
                    for depth in INWARD_PROBES:
                        y = roof_height(px + inward[0] * depth, pz + inward[1] * depth)
                        if y is not None:
                            break
                    profile.append([t, y])
                known = [y for _, y in profile if y is not None]
                if not known:
                    ring_profile.append([])
                    continue
                # Fill gaps from neighbouring measured samples along the edge.
                ts = np.array([t for t, _ in profile])
                ys = np.array([np.nan if y is None else y for _, y in profile])
                good = ~np.isnan(ys)
                ys = np.interp(ts, ts[good], ys[good])
                # Drop collinear interior samples (2 cm tolerance).
                keep = [0]
                for i in range(1, len(ts) - 1):
                    a, b = keep[-1], i + 1
                    expected = ys[a] + (ys[b] - ys[a]) * (ts[i] - ts[a]) / max(ts[b] - ts[a], 1e-9)
                    if abs(ys[i] - expected) > 0.02:
                        keep.append(i)
                keep.append(len(ts) - 1)
                flat = []
                for i in keep:
                    flat += [round(float(ts[i]), 4), round(float(ys[i]), 2)]
                    tops.append(float(ys[i]))
                ring_profile.append(flat)
            profiles.append(ring_profile)
        if not tops:
            statistics["withoutWallProfile"] += 1
            continue
        tops = np.array(tops)
        # Walls rising from the roof face away from the mass they enclose:
        # the side with measured roof above the wall's mid-height is inside.
        for face in mine:
            if face["class"] != "wall":
                continue
            outer = face["rings"][0]
            n = face["normal"]
            horizontal = np.array([n[0], n[2]])
            length = np.linalg.norm(horizontal)
            if length < 1e-6:
                continue
            horizontal /= length
            centre = outer.mean(axis=0)

            def enclosed(side):
                probe = centre[[0, 2]] + side * horizontal * 0.35
                above = roof_height(*probe)
                return above is not None and above > centre[1] + 0.05

            if enclosed(1) and not enclosed(-1):
                face["normal"] = -n
        # Mesh: measured roofs and details, plus walls rising from the roof.
        vertex_start = len(positions) // 3
        roof_tris, wall_tris = [], []
        shared = {}
        for face in mine:
            vertices, triangles = triangulate(face["rings"], face["normal"])
            if vertices is None:
                statistics["degenerateFaces"] += 1
                continue
            local = []
            for x, y, z in vertices:
                key = (int(round(x * 100)), int(round(y * 100)), int(round(z * 100)))
                if key not in shared:
                    shared[key] = len(positions) // 3 - vertex_start
                    positions += key
                local.append(shared[key])
            local = np.asarray(local)[triangles]
            # Centimetre rounding can collapse or flip slivers: drop
            # triangles under 0.005 m² and re-orient the rest to the face.
            rounded = np.asarray(positions[vertex_start * 3:], dtype=np.float64).reshape(-1, 3) / 100
            ta, tb, tc = rounded[local[:, 0]], rounded[local[:, 1]], rounded[local[:, 2]]
            cross = np.cross(tb - ta, tc - ta)
            area = np.linalg.norm(cross, axis=1) / 2
            keep = area >= 0.005
            flip = keep & (cross @ face["normal"] < 0)
            local[flip] = local[flip][:, [0, 2, 1]]
            statistics["droppedSlivers"] += int((~keep).sum())
            target = roof_tris if face["class"] == "roof" else wall_tris
            target.extend(local[keep].ravel().tolist())
            statistics[face["class"] + "Faces"] += 1
        vertex_count = len(positions) // 3 - vertex_start
        if vertex_count > 65535:
            raise ValueError(f"{building['osmId']} needs 32-bit indices")
        roof_start = len(indices)
        indices += roof_tris
        wall_start = len(indices)
        indices += wall_tris
        output_buildings.append({
            "osmId": building["osmId"],
            "anchor": building["anchor"],
            "ipr": ipr_ids,
            "updated": max(face["updated"] for face in mine),
            "ground": round(min(ground_samples), 2) if ground_samples else None,
            "eaves": round(float(np.percentile(tops, 25)), 2),
            "eavesMax": round(float(tops.max()), 2),
            "ridge": round(ridge, 2),
            "coverage": round(covered, 3),
            "vertexStart": vertex_start,
            "vertexCount": vertex_count,
            "roofIndexStart": roof_start,
            "roofIndexCount": len(roof_tris),
            "wallIndexStart": wall_start,
            "wallIndexCount": len(wall_tris),
            "walls": profiles,
        })
        statistics["buildings"] += 1
    positions = np.asarray(positions, dtype=np.int64).reshape(-1, 3)
    # Delta coding per building keeps the gzip transfer small.
    deltas = positions.copy()
    for item in output_buildings:
        a, b = item["vertexStart"], item["vertexStart"] + item["vertexCount"]
        deltas[a + 1:b] = positions[a + 1:b] - positions[a:b - 1]
    if np.abs(deltas).max() >= 2 ** 31:
        raise ValueError("Coordinate exceeds the encoded range")
    result = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "source": {
            "dataset": manifest["datasets"]["buildings"],
            "manifest": str(args.manifest),
            "manifestSha256": sha256_file(args.manifest),
            "sheets": sheets,
            "osmFootprints": {"city": sha256_file(args.city), "context": sha256_file(args.context)},
            "description": "Photogrammetric 3D buildings (roofs at least 0.5 m accuracy, walls derived from roofs).",
        },
        "coordinateTransform": projection.metadata,
        "origin": origin,
        "baselineAltitude": baseline,
        "method": {
            "corridorMeters": CORRIDOR, "minimumRoofCoverage": COVERAGE,
            "facadeBandMeters": FACADE_BAND, "roofAssignmentMeters": ASSIGN_DISTANCE,
            "profileStepMeters": PROFILE_STEP, "inwardProbesMeters": list(INWARD_PROBES),
            "assignment": "Roof and detail faces belong to the current OSM footprint containing their plan centroid "
                          "(or the nearest within roofAssignmentMeters for overhangs); walls on a footprint outline "
                          "are rendered from the OSM outline with the measured top profile.",
        },
        "encoding": {
            "positions": "Int32 little-endian centimetres (world x, y = altitude - baselineAltitude, z), "
                         "delta coded from the previous vertex of the same building, base64",
            "indices": "Uint16 little-endian, local to each building's vertexStart, base64",
            "walls": "Per ring, per OSM edge (points[i] to points[i + 1]): flattened [t, y] pairs, "
                     "y in world metres; empty when the edge has no measured roof",
        },
        "statistics": {**statistics, "unassigned": dict(unassigned), "iprBuildingsInCorridor": len(ipr_buildings_seen)},
        "buildings": output_buildings,
        "positions": encode_ints(deltas.ravel(), "<i4"),
        "indices": encode_ints(indices, "<u2"),
    }
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    args.output.write_text(text + "\n", "utf-8")
    print(json.dumps({**result["statistics"], "vertices": int(len(positions)), "triangles": len(indices) // 3,
                      "bytes": len(text), "sha256": hashlib.sha256(text.encode()).hexdigest()}))


if __name__ == "__main__":
    main()
