#!/usr/bin/env python3
"""Measure heights above ground from the IPR Praha 2025 surface model.

"Digitální model povrchu – 1m" of IPR Praha (aerial photogrammetry, 2025,
CC BY 4.0, datový podklad © IPR Praha) records the top of everything: roofs,
tree crowns, walls and statues. Subtracting the bare-earth lidar terrain
(public/data/terrain-lidar.json) gives a height above ground, used here to:

* measure the height of every surveyed tree in trees-ipr.json and of the OSM
  trees (crown top within 2.5 m of the trunk position);
* detect trees missing from both inventories (gardens, courtyards, forests)
  as convex crown peaks outside buildings, bridges and water;
* measure free-standing walls, masonry fences, hedges and monuments in
  street-features.json (robust lower quartile along a wall).

Run after scripts/extract-ipr-trees.py and scripts/import-dtm-street-features.py:

  python3 scripts/import-surface-measurements.py --surface /path/DSM_1m.tif \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif
"""

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import Projection, SurfaceModel, sha256_file  # noqa: E402

MIN_TREE = 4.0          # detected crowns must stand at least 4 m above ground
DETECTION_DISTANCE = 200


class Lidar:
    """Vectorised bilinear sampler of terrain-lidar.json (world metres)."""

    def __init__(self, data):
        self.size = data["tileSize"]
        self.tiles = {(t["x"], t["z"]): t for t in data["tiles"]}
        self.grids = {}

    def grid(self, key):
        if key not in self.grids:
            tile = self.tiles[key]
            values = np.cumsum(np.frombuffer(base64.b64decode(tile["data"]), dtype="<u2").astype(np.int64)) & 0xFFFF
            self.grids[key] = np.where(values == 0xFFFF, np.nan, values / 100.0).reshape(tile["n"], tile["n"])
        return self.grids[key]

    def altitude(self, x, z):
        x, z = np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(z, float))
        out = np.full(x.shape, np.nan)
        tx, tz = np.floor(x / self.size).astype(int), np.floor(z / self.size).astype(int)
        for key in set(zip(tx.tolist(), tz.tolist())):
            if key not in self.tiles:
                continue
            m = (tx == key[0]) & (tz == key[1])
            tile, grid = self.tiles[key], self.grid(key)
            gx = (x[m] - key[0] * self.size) / tile["step"]
            gz = (z[m] - key[1] * self.size) / tile["step"]
            ix = np.clip(gx.astype(int), 0, tile["n"] - 2)
            iz = np.clip(gz.astype(int), 0, tile["n"] - 2)
            fx, fz = gx - ix, gz - iz
            out[m] = (grid[iz, ix] * (1 - fx) * (1 - fz) + grid[iz, ix + 1] * fx * (1 - fz)
                      + grid[iz + 1, ix] * (1 - fx) * fz + grid[iz + 1, ix + 1] * fx * fz)
        return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--surface", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--data", type=Path, default=Path("public/data"))
    args = parser.parse_args()
    d = args.data
    route = json.loads((d / "route22.json").read_text("utf-8"))
    lidar = Lidar(json.loads((d / "terrain-lidar.json").read_text("utf-8")))
    surface = SurfaceModel(args.surface)
    projection = Projection(route, args.grid)
    origin, cos = route["origin"], math.cos(math.radians(route["origin"]["lat"]))

    def world(lat, lon):
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        return (lon - origin["lon"]) * 111320 * cos, -(lat - origin["lat"]) * 111320

    def to_latlon(x, z):
        return origin["lat"] - np.asarray(z) / 111320, origin["lon"] + np.asarray(x) / (111320 * cos)

    def crown_top(lat, lon, radius=2.5):
        """Highest surface within `radius` minus the terrain at the point."""
        ex, ny = projection.to_native.transform(lon, lat)
        tops = []
        for e, n in zip(np.atleast_1d(ex), np.atleast_1d(ny)):
            window, _, _ = surface.window(e - radius, n - radius, e + radius, n + radius)
            tops.append(np.nanmax(window) if np.isfinite(window).any() else np.nan)
        x, z = world(lat, lon)
        return np.asarray(tops) - lidar.altitude(x, z)

    surface_meta = {
        "title": "IPR Praha, Digitální model povrchu – 1m (DSM 2025)",
        "catalogue": "https://opendata.geoportalpraha.cz/maps/iprpraha::digitální-model-povrchu-1m",
        "url": "https://www.arcgis.com/sharing/rest/content/items/a6120ef1652e4df2b1202c1a8ad4e0c7/data",
        "rasterBytes": args.surface.stat().st_size,
        "terrain": "public/data/terrain-lidar.json",
    }

    # --- Trees ---------------------------------------------------------------
    trees = json.loads((d / "trees-ipr.json").read_text("utf-8"))
    city = json.loads((d / "city.json").read_text("utf-8"))
    context = json.loads((d / "city-context.json").read_text("utf-8"))
    if trees["trees"] and len(trees["trees"][0]) > 4:
        trees["trees"] = [row[:4] for row in trees["trees"]]
    lat = np.array([t[0] for t in trees["trees"]])
    lon = np.array([t[1] for t in trees["trees"]])
    heights = crown_top(lat, lon)
    measured = 0
    for row, h in zip(trees["trees"], heights):
        valid = bool(np.isfinite(h) and 3.0 <= h <= 40)
        row.append(round(float(h), 1) if valid else None)
        measured += valid
    osm_heights = []
    olat = np.array([t["lat"] for t in city["trees"]])
    olon = np.array([t["lon"] for t in city["trees"]])
    for t, h in zip(city["trees"], crown_top(olat, olon)):
        if np.isfinite(h) and 3.0 <= h <= 40:
            osm_heights.append([t["lat"], t["lon"], round(float(h), 1)])
    print(f"Tree heights: {measured}/{len(trees['trees'])} IPR, {len(osm_heights)}/{len(city['trees'])} OSM", flush=True)

    # Detection of unmapped crowns near the line.
    line = LineString(np.column_stack(world([p["lat"] for p in route["points"]], [p["lon"] for p in route["points"]])))
    corridor = line.buffer(DETECTION_DISTANCE)
    blockers = []
    for building in [*city["buildings"], *context["buildings"]]:
        ring = np.column_stack(world([p[0] for p in building["points"]], [p[1] for p in building["points"]]))
        if len(ring) >= 4:
            poly = Polygon(ring)
            if poly.is_valid and poly.intersects(corridor):
                blockers.append(poly.buffer(1.5))
    for water in city.get("waters", []):
        ring = np.column_stack(world([p[0] for p in water["points"]], [p[1] for p in water["points"]]))
        if len(ring) >= 4:
            poly = Polygon(ring).buffer(0)
            if poly.intersects(corridor):
                blockers.append(poly)
    bridges = json.loads((d / "bridges-3d.json").read_text("utf-8"))
    bridge_positions = np.frombuffer(base64.b64decode(bridges["positions"]), dtype="<i4").reshape(-1, 3).astype(np.int64)
    for bridge in bridges["bridges"]:
        a, n = bridge["vertexStart"], bridge["vertexCount"]
        v = np.cumsum(bridge_positions[a:a + n], axis=0) / 100
        hull = shapely.convex_hull(shapely.multipoints(v[:, [0, 2]]))
        if hull.intersects(corridor):
            blockers.append(hull.buffer(2))
    blocker_tree = STRtree(blockers)
    woodland = json.loads((d / "woodland.json").read_text("utf-8"))
    forests = [Polygon(np.column_stack(world([p[0] for p in a["points"]], [p[1] for p in a["points"]]))).buffer(0)
               for a in woodland["areas"]]
    forest_tree = STRtree(forests)
    known = np.vstack([np.column_stack(world(lat, lon)), np.column_stack(world(olat, olon))])
    known_tree = STRtree(shapely.points(known[:, 0], known[:, 1]))
    minx, minz, maxx, maxz = corridor.bounds
    detected = []
    size = 200
    for x0 in np.arange(minx, maxx, size):
        for z0 in np.arange(minz, maxz, size):
            cell = shapely.box(x0, z0, x0 + size, z0 + size)
            if not cell.intersects(corridor):
                continue
            cx = np.array([x0 - 6, x0 + size + 6, x0 - 6, x0 + size + 6])
            cz = np.array([z0 - 6, z0 - 6, z0 + size + 6, z0 + size + 6])
            ex, ny = projection.world_to_native(cx, cz)
            ex, ny = np.asarray(ex), np.asarray(ny)
            raw, xs, ys = surface.window(ex.min(), ny.min(), ex.max(), ny.max())
            if not np.isfinite(raw).any():
                continue
            gx, gy = np.meshgrid(xs, ys)
            wx, wz = projection.native_to_world(gx.ravel(), gy.ravel())
            wx, wz = np.asarray(wx).reshape(raw.shape), np.asarray(wz).reshape(raw.shape)
            chm = raw - lidar.altitude(wx.ravel(), wz.ravel()).reshape(raw.shape)
            chm = np.where(np.isfinite(chm), chm, 0)
            padded = np.pad(chm, 3, constant_values=0)
            windows = np.lib.stride_tricks.sliding_window_view(padded, (7, 7))
            peak = (chm >= MIN_TREE) & (chm >= windows.max(axis=(-1, -2)) - 1e-6)
            # Crown dome: the 3 m ring sits clearly below the peak; flat roofs
            # and walls of unmapped structures do not.
            ring_mask = np.zeros((7, 7), bool)
            ring_mask[[0, 0, 6, 6, 3, 3, 0, 6], [0, 6, 0, 6, 0, 6, 3, 3]] = True
            ring_mean = (windows * ring_mask).sum(axis=(-1, -2)) / ring_mask.sum()
            # A gable ridge stays level along its axis; a crown falls away in
            # every direction, so the highest ring sample must be lower too.
            ring_max = np.where(ring_mask, windows, -np.inf).max(axis=(-1, -2))
            rows, cols = np.nonzero(peak)
            for r, c in zip(rows, cols):
                x, z = float(wx[r, c]), float(wz[r, c])
                if not (x0 <= x < x0 + size and z0 <= z < z0 + size):
                    continue
                p = shapely.Point(x, z)
                if not corridor.contains(p) or len(blocker_tree.query(p, predicate="intersects")):
                    continue
                in_forest = len(forest_tree.query(p, predicate="intersects")) > 0
                if chm[r, c] - ring_mean[r, c] < (0.3 if in_forest else 0.7):
                    continue
                if not in_forest and chm[r, c] - ring_max[r, c] < 0.25:
                    continue
                if len(known_tree.query(p, predicate="dwithin", distance=3.5)):
                    continue
                crown = windows[r, c] > chm[r, c] * 0.6
                radius = math.sqrt(crown.sum() / math.pi)
                detected.append([x, z, round(float(chm[r, c]), 1), round(min(radius, 3.5), 1), int(in_forest)])
    # Thin out duplicate peaks of one crown (closer than 3 m keeps the taller).
    detected.sort(key=lambda t: -t[2])
    kept = []
    grid = {}
    for x, z, h, r, f in detected:
        key = (int(x // 3), int(z // 3))
        if any(math.hypot(x - a, z - b) < 3 for i in (-1, 0, 1) for j in (-1, 0, 1)
               for a, b in grid.get((key[0] + i, key[1] + j), ())):
            continue
        grid.setdefault(key, []).append((x, z))
        kept.append((x, z, h, r, f))
    dlat, dlon = to_latlon([k[0] for k in kept], [k[1] for k in kept])
    trees["detected"] = [[round(float(a), 7), round(float(o), 7), h, r, f]
                         for a, o, (_, _, h, r, f) in zip(dlat, dlon, kept)]
    trees["osmHeights"] = osm_heights
    trees["fields"] = ["lat", "lon", "category (kod_drevin)", "streetRow (id_strom present)",
                       "measuredHeight (DSM 2025 crown top minus lidar terrain; null if no crown)"]
    trees["detectedFields"] = ["lat", "lon", "height", "crownRadius", "inMappedWoodland"]
    trees["surfaceMeasurement"] = {
        **surface_meta,
        "treeHeight": "Highest surface within 2.5 m of the mapped position minus bare-earth terrain; 3–40 m accepted.",
        "detection": (f"Crown peaks >= {MIN_TREE:g} m within {DETECTION_DISTANCE} m of the line, highest in a 7 m window, "
                      "a 3 m ring at least 0.7 m lower on average and 0.25 m lower everywhere (inside mapped woodland "
                      "0.3 m on average), outside buildings (+1.5 m), "
                      "water and bridges, at least 3.5 m from mapped trees and 3 m from each other."),
    }
    trees["counts"]["measuredHeights"] = measured
    trees["counts"]["detected"] = len(kept)
    trees["counts"]["detectedRemovedWithoutVegetation"] = 0
    trees["counts"]["detectedInWoodland"] = sum(k[4] for k in kept)
    (d / "trees-ipr.json").write_text(json.dumps(trees, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print(f"Detected {len(kept)} unmapped crowns ({trees['counts']['detectedInWoodland']} in woodland)", flush=True)

    # --- Walls, hedges and monuments ------------------------------------------
    features = json.loads((d / "street-features.json").read_text("utf-8"))
    measured_lines = 0
    for feature in features["lines"]:
        feature.pop("measuredHeight", None)
        wanted = (feature["kind"] == "wall" and feature["type"] not in ("retaining", "revetment")) or \
                 (feature["kind"] == "fence" and feature["type"] in ("masonry", "hedge"))
        if not wanted:
            continue
        pts = np.array(feature["points"])
        x, z = world(pts[:, 0], pts[:, 1])
        geometry = LineString(np.column_stack([x, z]))
        if geometry.length < 1:
            continue
        stations = [geometry.interpolate(t) for t in np.arange(0.5, geometry.length, 1.0)]
        sx = np.array([p.x for p in stations])
        sz = np.array([p.y for p in stations])
        slat, slon = to_latlon(sx, sz)
        heights = crown_top(slat, slon, radius=0.6)
        heights = heights[np.isfinite(heights)]
        if len(heights) < 2 or (heights > 0.4).mean() < 0.5:
            continue
        value = float(np.percentile(heights, 30))
        limit = 14 if feature["type"] == "city-wall" else 6
        if 0.5 <= value <= limit:
            feature["measuredHeight"] = round(value, 2)
            measured_lines += 1
    measured_points = 0
    for feature in features["points"]:
        feature.pop("measuredHeight", None)
        if feature["kind"] not in ("monument", "shrine"):
            continue
        h = float(crown_top(np.array([feature["lat"]]), np.array([feature["lon"]]), radius=1.5)[0])
        if np.isfinite(h) and 0.5 <= h <= 25:
            feature["measuredHeight"] = round(h, 2)
            measured_points += 1
    features["surfaceMeasurement"] = {
        **surface_meta,
        "method": "Free-standing walls, masonry fences and hedges: 30th percentile of the highest surface within "
                  "0.6 m of 1 m stations minus lidar terrain; monuments and shrines: highest surface within 1.5 m.",
        "measuredLines": measured_lines,
        "measuredPoints": measured_points,
    }
    (d / "street-features.json").write_text(json.dumps(features, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print(json.dumps({"treeHeights": measured, "osmTreeHeights": len(osm_heights), "detectedTrees": len(kept),
                      "measuredLines": measured_lines, "measuredPoints": measured_points}))


if __name__ == "__main__":
    main()
