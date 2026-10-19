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
from ipr_3d_sources import Projection, SurfaceModel, open_shapefile, sha256_file, verified_archives  # noqa: E402

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


class LidarGrid:
    """Bilinear sampler of public/data/terrain-lidar.json in world metres."""

    def __init__(self, data):
        self.size = data["tileSize"]
        self.tiles = {(tile["x"], tile["z"]): tile for tile in data["tiles"]}
        self.grids = {}

    def altitude(self, x, z):
        key = (math.floor(x / self.size), math.floor(z / self.size))
        tile = self.tiles.get(key)
        if tile is None:
            return math.nan
        if key not in self.grids:
            values = np.cumsum(np.frombuffer(base64.b64decode(tile["data"]), dtype="<u2").astype(np.int64)) & 0xFFFF
            self.grids[key] = np.where(values == 0xFFFF, np.nan, values / 100.0).reshape(tile["n"], tile["n"])
        grid = self.grids[key]
        gx = (x - key[0] * self.size) / tile["step"]
        gz = (z - key[1] * self.size) / tile["step"]
        ix, iz = min(tile["n"] - 2, int(gx)), min(tile["n"] - 2, int(gz))
        fx, fz = gx - ix, gz - iz
        return float(grid[iz, ix] * (1 - fx) * (1 - fz) + grid[iz, ix + 1] * fx * (1 - fz)
                     + grid[iz + 1, ix] * (1 - fx) * fz + grid[iz + 1, ix + 1] * fx * fz)


class SurfaceRoof:
    """Roof heights of one footprint from the 1 m surface model (world frame).

    A 3×3 median removes single-pixel noise; an affine fit of the local
    projection maps world points to pixels without per-point transforms.
    """

    def __init__(self, surface, projection, polygon, baseline):
        minx, minz, maxx, maxz = polygon.bounds
        cx = np.array([minx - 3, maxx + 3, minx - 3, maxx + 3])
        cz = np.array([minz - 3, minz - 3, maxz + 3, maxz + 3])
        ex, ny = projection.world_to_native(cx, cz)
        ex, ny = np.asarray(ex), np.asarray(ny)
        raw, xs, ys = surface.window(ex.min(), ny.min(), ex.max(), ny.max())
        padded = np.pad(raw, 1, mode="edge")
        stack = np.lib.stride_tricks.sliding_window_view(padded, (3, 3)).reshape(raw.shape + (9,))
        self.grid = np.nanmedian(stack, axis=-1) - baseline
        # Affine world -> fractional pixel (row, col) fitted on the corners.
        design = np.column_stack([cx, cz, np.ones(4)])
        cols = (ex - surface.x0) / surface.cell - 0.5 - (xs[0] - surface.x0) / surface.cell + 0.5
        rows = (surface.y0 - ny) / surface.cell - 0.5 - (surface.y0 - ys[0]) / surface.cell + 0.5
        self.col_fit = np.linalg.lstsq(design, cols, rcond=None)[0]
        self.row_fit = np.linalg.lstsq(design, rows, rcond=None)[0]

    def height(self, x, z):
        x = np.asarray(x, dtype=float)
        z = np.asarray(z, dtype=float)
        col = self.col_fit[0] * x + self.col_fit[1] * z + self.col_fit[2]
        row = self.row_fit[0] * x + self.row_fit[1] * z + self.row_fit[2]
        h, w = self.grid.shape
        c0 = np.clip(np.floor(col).astype(int), 0, w - 2)
        r0 = np.clip(np.floor(row).astype(int), 0, h - 2)
        fc = np.clip(col - c0, 0, 1)
        fr = np.clip(row - r0, 0, 1)
        g = self.grid
        return (g[r0, c0] * (1 - fc) * (1 - fr) + g[r0, c0 + 1] * fc * (1 - fr)
                + g[r0 + 1, c0] * (1 - fc) * fr + g[r0 + 1, c0 + 1] * fc * fr)


def interior_samples(polygon, spacing=1.0, inset=0.6):
    core = polygon.buffer(-inset)
    if core.is_empty:
        core = polygon.buffer(-0.2)
    if core.is_empty:
        return np.empty((0, 2))
    minx, minz, maxx, maxz = core.bounds
    gx, gz = np.meshgrid(np.arange(minx, maxx + spacing, spacing), np.arange(minz, maxz + spacing, spacing))
    gx, gz = gx.ravel(), gz.ravel()
    import shapely
    inside = shapely.contains_xy(core, gx, gz)
    return np.column_stack([gx[inside], gz[inside]])


def roughness(roof, samples):
    """Median deviation from the 4-neighbour mean: planes ~0, tree crowns >0.3 m."""
    x, z = samples[:, 0], samples[:, 1]
    centre = roof.height(x, z)
    around = (roof.height(x + 1, z) + roof.height(x - 1, z) + roof.height(x, z + 1) + roof.height(x, z - 1)) / 4
    deviation = np.abs(centre - around)
    deviation = deviation[np.isfinite(deviation)]
    return float(np.median(deviation)) if len(deviation) else 0.0


def adaptive_heightfield(polygon, height, tolerance=0.2):
    """Triangulate a footprint so a coarse 3 m net gains 1.5 m points only
    where the surface departs from it by more than `tolerance`."""
    import shapely

    def triangulate_points(points):
        triangles = shapely.get_parts(shapely.delaunay_triangles(shapely.multipoints(points)))
        return triangles[shapely.contains(polygon, shapely.centroid(triangles))]

    boundary = []
    for ring in [polygon.exterior, *polygon.interiors]:
        for d in np.arange(0, ring.length, 2.0):
            p = ring.interpolate(d)
            boundary.append((p.x, p.y))
    boundary = np.asarray(boundary)
    coarse = interior_samples(polygon, spacing=3.0, inset=0.8)
    points = np.vstack([boundary, coarse]) if len(coarse) else boundary
    triangles = triangulate_points(points)
    fine = interior_samples(polygon, spacing=1.5, inset=0.6)
    if len(fine) and len(triangles):
        tree = STRtree(triangles)
        hit_points, hit_triangles = tree.query(shapely.points(fine[:, 0], fine[:, 1]), predicate="intersects")
        error = np.zeros(len(fine))
        for pi, ti in zip(hit_points, hit_triangles):
            (ax, az), (bx, bz), (cx, cz) = np.asarray(triangles[ti].exterior.coords)[:3]
            px, pz = fine[pi]
            det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
            if abs(det) < 1e-9:
                continue
            w1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det
            w2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det
            w3 = 1 - w1 - w2
            interpolated = w1 * height(ax, az) + w2 * height(bx, bz) + w3 * height(cx, cz)
            error[pi] = abs(height(px, pz) - interpolated)
        extra = fine[error > tolerance]
        if len(extra):
            triangles = triangulate_points(np.vstack([points, extra]))
    return triangles


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
    parser.add_argument("--surface", type=Path, help="IPR DSM_1m.tif (2025 surface model)")
    parser.add_argument("--lidar", type=Path, default=Path("public/data/terrain-lidar.json"))
    args = parser.parse_args()
    surface = SurfaceModel(args.surface) if args.surface else None
    lidar = LidarGrid(json.loads(args.lidar.read_text("utf-8")))
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

    def wall_profiles(building, polygon, roof_height, hints=None, probes=INWARD_PROBES):
        """Measured wall-top profile of every footprint edge (outer ring and courtyards)."""
        profiles, tops = [], []
        for ring in building["rings"]:
            ring_profile = []
            closed = ring if ring[0] == ring[-1] else ring + [ring[0]]
            orientation = 1 if Polygon(closed).exterior.is_ccw else -1
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
                for vx, vz in hints(LineString([(x1, z1), (x2, z2)]).buffer(1.2)) if hints else ():
                    t = ((vx - x1) * ux + (vz - z1) * uz) / length
                    offset = abs((vx - x1) * -uz + (vz - z1) * ux)
                    if 0 < t < 1 and offset < 1.2:
                        stations.add(round(t, 5))
                profile = []
                for t in sorted(stations):
                    px, pz = x1 + (x2 - x1) * t, z1 + (z2 - z1) * t
                    y = None
                    for depth in probes:
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
        return profiles, np.array(tops)

    def emit(parts):
        """Append (vertices, triangles, class, normal) parts as one building mesh."""
        vertex_start = len(positions) // 3
        roof_tris, wall_tris = [], []
        shared = {}
        for vertices, triangles, kind, normal in parts:
            local = []
            for x, y, z in vertices:
                key = (int(round(x * 100)), int(round(y * 100)), int(round(z * 100)))
                if key not in shared:
                    shared[key] = len(positions) // 3 - vertex_start
                    positions.extend(key)
                local.append(shared[key])
            local = np.asarray(local)[triangles]
            # Centimetre rounding can collapse or flip slivers: drop
            # triangles under 0.005 m² and re-orient the rest to the face.
            rounded = np.asarray(positions[vertex_start * 3:], dtype=np.float64).reshape(-1, 3) / 100
            ta, tb, tc = rounded[local[:, 0]], rounded[local[:, 1]], rounded[local[:, 2]]
            cross = np.cross(tb - ta, tc - ta)
            area = np.linalg.norm(cross, axis=1) / 2
            keep = area >= 0.005
            reference = np.broadcast_to(normal, cross.shape)
            flip = keep & (np.einsum("ij,ij->i", cross, reference) < 0)
            local[flip] = local[flip][:, [0, 2, 1]]
            statistics["droppedSlivers"] += int((~keep).sum())
            (roof_tris if kind == "roof" else wall_tris).extend(local[keep].ravel().tolist())
            statistics[kind + "Faces"] += 1
        vertex_count = len(positions) // 3 - vertex_start
        if vertex_count > 65535:
            raise ValueError("Building mesh needs 32-bit indices")
        roof_start = len(indices)
        indices.extend(roof_tris)
        wall_start = len(indices)
        indices.extend(wall_tris)
        return {"vertexStart": vertex_start, "vertexCount": vertex_count,
                "roofIndexStart": roof_start, "roofIndexCount": len(roof_tris),
                "wallIndexStart": wall_start, "wallIndexCount": len(wall_tris)}

    def surface_building(building, polygon, reason):
        """Roof, eaves and ridge of a footprint from the 2025 surface model."""
        if surface is None or polygon.area < 6:
            statistics["withoutSurfaceRoof:" + reason] += 1
            return None
        roof = SurfaceRoof(surface, projection, polygon, baseline)
        samples = interior_samples(polygon)
        if len(samples) < 4:
            statistics["withoutSurfaceRoof:small"] += 1
            return None
        values = roof.height(samples[:, 0], samples[:, 1])
        values = values[np.isfinite(values)]
        outline = np.asarray(polygon.exterior.coords)
        ground = np.nanmin([lidar.altitude(x, z) for x, z in outline]) - baseline
        if len(values) < 4 or np.percentile(values, 75) - ground < 2.2:
            # No mass in the 2025 survey: built later or not a roofed building.
            statistics["withoutSurfaceRoof:no-mass"] += 1
            return None
        if roughness(roof, samples) > 0.3:
            # Tree crowns over the footprint, not a measurable roof.
            statistics["withoutSurfaceRoof:vegetation"] += 1
            return None
        eaves = float(np.percentile(values, 15))
        ridge = float(np.percentile(values, 98))
        inside = polygon.buffer(0.05)

        def roof_height(x, z):
            if not inside.contains(Point(x, z)):
                return None
            return float(min(ridge, max(eaves - 0.5, roof.height(x, z))))

        profiles, tops = wall_profiles(building, polygon, roof_height, probes=(0.6, 0.9, 1.3, 1.8))
        if not len(tops):
            statistics["withoutSurfaceRoof:profile"] += 1
            return None
        parts = []
        if ridge - eaves < 1.2:
            # Flat roof: one plane at the measured median.
            level = float(np.median(values))
            rings = [np.column_stack([np.asarray(r)[:, 0], np.full(len(r), level), np.asarray(r)[:, 1]])
                     for r in [polygon.exterior.coords[:-1], *[h.coords[:-1] for h in polygon.interiors]]]
            vertices, triangles = triangulate(rings, np.array([0.0, 1.0, 0.0]))
            if vertices is not None:
                parts.append((vertices, triangles, "roof", np.array([0.0, 1.0, 0.0])))
            for i in range(len(profiles)):
                profiles[i] = [[0, round(level, 2), 1, round(level, 2)] if edge else edge for edge in profiles[i]]
            tops = np.full(1, level)
        else:
            # Pitched or stepped: an adaptive heightfield clipped to the
            # footprint; outline vertices take the roof 0.6 m inside so the
            # blurred wall edge of the surface model does not slope the eaves.
            core = polygon.buffer(-0.6)

            def surface_height(x, z):
                q = Point(x, z)
                if core.geom_type == "Polygon" and not core.is_empty and not core.contains(q):
                    q = core.exterior.interpolate(core.exterior.project(q))
                return min(ridge, max(eaves - 0.5, float(roof.height(q.x, q.y))))

            triangles = adaptive_heightfield(polygon, surface_height)
            if not len(triangles):
                statistics["withoutSurfaceRoof:triangulation"] += 1
                return None
            coords = np.asarray([np.asarray(t.exterior.coords)[:3] for t in triangles])
            flatpts = coords.reshape(-1, 2)
            heights = [surface_height(x, z) for x, z in flatpts]
            vertices = np.column_stack([flatpts[:, 0], heights, flatpts[:, 1]])
            tris = np.arange(len(vertices)).reshape(-1, 3)
            parts.append((vertices, tris, "roof", np.array([0.0, 1.0, 0.0])))
        record = emit(parts)
        statistics["surfaceRoofs:" + reason] += 1
        return {
            "osmId": building["osmId"],
            "anchor": building["anchor"],
            "ipr": [],
            "source": "DSM2025",
            "updated": "2025",
            "ground": round(float(ground), 2),
            "eaves": round(float(np.percentile(tops, 25)), 2),
            "eavesMax": round(float(tops.max()), 2),
            "ridge": round(ridge, 2),
            "coverage": 1,
            **record,
            "walls": profiles,
        }

    for index, building in enumerate(osm):
        mine = owned.get(index, [])
        roofs = [face for face in mine if face["class"] == "roof"]
        polygon = building["polygon"]
        # Roofs are seen from above; the photogrammetric winding is arbitrary.
        for face in roofs:
            if face["normal"][1] < 0:
                face["normal"] = -face["normal"]
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
            plans.append(plan)
            planes.append((n, outer.mean(axis=0)))
        covered = (unary_union(plans).intersection(polygon).area / max(polygon.area, 1e-9)) if plans else 0
        if not plans or covered < COVERAGE:
            reason = "withoutMeasuredRoof" if not plans else "insufficientCoverage"
            statistics[reason] += 1
            record = surface_building(building, polygon, reason)
            if record:
                output_buildings.append(record)
                statistics["buildings"] += 1
            continue
        tree = STRtree(plans)

        def roof_height(x, z):
            hits = tree.query(Point(x, z), predicate="intersects")
            best = None
            for i in hits:
                n, c = planes[i]
                y = c[1] - (n[0] * (x - c[0]) + n[2] * (z - c[2])) / n[1]
                best = y if best is None else max(best, y)
            return best

        if surface is not None:
            # A roof rebuilt or a building replaced since the photogrammetric
            # survey disagrees with the 2025 surface model over most of it.
            samples = interior_samples(polygon, spacing=1.5)[:600]
            if len(samples) >= 8:
                current = SurfaceRoof(surface, projection, polygon, baseline)
                measured = np.array([roof_height(x, z) if roof_height(x, z) is not None else np.nan
                                     for x, z in samples])
                observed = current.height(samples[:, 0], samples[:, 1])
                difference = np.abs(observed - measured)
                difference = difference[np.isfinite(difference)]
                if (len(difference) >= 8 and np.median(difference) > 2.5 and (difference > 2).mean() > 0.5
                        and roughness(current, samples) <= 0.3):
                    statistics["outdatedMeasuredRoof"] += 1
                    record = surface_building(building, polygon, "outdated")
                    if record:
                        output_buildings.append(record)
                        statistics["buildings"] += 1
                        continue

        ipr_ids = sorted({face["ipr"] for face in mine})
        ground_samples = [value for ipr_id in ipr_ids for value in slabs.get(ipr_id, [])]
        ridge = float(np.concatenate([face["rings"][0][:, 1] for face in roofs]).max())
        profiles, tops = wall_profiles(
            building, polygon, roof_height,
            hints=lambda area: [xy for i in tree.query(area) for xy in plans[i].exterior.coords])
        if not len(tops):
            statistics["withoutWallProfile"] += 1
            continue
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
        parts = []
        for face in mine:
            vertices, triangles = triangulate(face["rings"], face["normal"])
            if vertices is None:
                statistics["degenerateFaces"] += 1
                continue
            parts.append((vertices, triangles, face["class"], face["normal"]))
        record = emit(parts)
        output_buildings.append({
            "osmId": building["osmId"],
            "anchor": building["anchor"],
            "ipr": ipr_ids,
            "source": "IPR",
            "updated": max(face["updated"] for face in mine),
            "ground": round(min(ground_samples), 2) if ground_samples else None,
            "eaves": round(float(np.percentile(tops, 25)), 2),
            "eavesMax": round(float(tops.max()), 2),
            "ridge": round(ridge, 2),
            "coverage": round(covered, 3),
            **record,
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
