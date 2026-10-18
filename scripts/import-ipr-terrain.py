#!/usr/bin/env python3
"""Resample the IPR Praha lidar terrain TIN to the scene's tiled height grid.

The "Model terénu 3D" of IPR Praha is a bare-earth TIN derived from airborne
laser scanning (about 40 points per m²) without buildings, bridges or
vegetation. Its triangles are sampled exactly (barycentric interpolation) at
the nodes of world-aligned 160 m tiles. Resolution follows the distance from
the PID route: 4 m near the line, 8 m in the visible middle distance and 20 m
for the background up to the edge of the rendered terrain rectangle.

  python3 scripts/import-ipr-terrain.py --cache-dir /private/tmp/linka-ipr-3d \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif --output public/data/terrain-lidar.json

XY uses the authoritative ČÚZK grid pipeline of the DTM importers, so the
terrain lines up with the surveyed street surfaces. Heights remain Bpv metres.
"""

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import sys

import numpy as np
from shapely.geometry import LineString, box

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import Projection, TerrainTin, open_shapefile, sha256_file, verified_archives  # noqa: E402

TILE = 160
LEVELS = [(260, 4.0), (650, 8.0), (math.inf, 20.0)]
MISSING = 0xFFFF


def encode(values_cm):
    """Row-major uint16 centimetres, delta coded for compression, base64."""
    flat = values_cm.astype(np.int64).ravel()
    deltas = np.empty_like(flat)
    deltas[0] = flat[0]
    deltas[1:] = flat[1:] - flat[:-1]
    return base64.b64encode((deltas & 0xFFFF).astype("<u2").tobytes()).decode("ascii")


def decode(text, count):
    deltas = np.frombuffer(base64.b64decode(text), dtype="<u2").astype(np.int64)
    if deltas.size != count:
        raise ValueError("Tile sample count differs from its declared size")
    return np.cumsum(deltas) & 0xFFFF


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, default=Path("docs/ipr-3d-manifest.json"))
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data/terrain-lidar.json"))
    parser.add_argument("--margin", type=float, default=700)
    args = parser.parse_args()
    route = json.loads(args.route.read_text("utf-8"))
    manifest = json.loads(args.manifest.read_text("utf-8"))
    projection = Projection(route, args.grid)
    origin = route["origin"]
    cos = math.cos(math.radians(origin["lat"]))
    world = np.array([[(p["lon"] - origin["lon"]) * 111320 * cos, -(p["lat"] - origin["lat"]) * 111320]
                      for p in route["points"]])
    line = LineString(world)
    min_x, min_z = world.min(axis=0) - args.margin
    max_x, max_z = world.max(axis=0) + args.margin
    tiles = []
    for tz in range(math.floor(min_z / TILE), math.floor(max_z / TILE) + 1):
        for tx in range(math.floor(min_x / TILE), math.floor(max_x / TILE) + 1):
            distance = line.distance(box(tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE))
            step = next(step for limit, step in LEVELS if distance <= limit)
            n = int(round(TILE / step)) + 1
            tiles.append({"x": tx, "z": tz, "step": step, "n": n, "distance": distance})
    # World sample nodes of every tile, converted once to native S-JTSK.
    offsets = np.cumsum([0] + [tile["n"] ** 2 for tile in tiles])
    xs = np.empty(offsets[-1])
    zs = np.empty(offsets[-1])
    for tile, start in zip(tiles, offsets[:-1]):
        grid = np.arange(tile["n"]) * tile["step"]
        gx, gz = np.meshgrid(tile["x"] * TILE + grid, tile["z"] * TILE + grid)
        xs[start:start + tile["n"] ** 2] = gx.ravel()
        zs[start:start + tile["n"] ** 2] = gz.ravel()
    ex, ny = projection.world_to_native(xs, zs)
    ex, ny = np.asarray(ex), np.asarray(ny)
    heights = np.full(xs.shape, np.nan)
    archives = verified_archives(manifest, args.cache_dir, "terrain")
    sheets = []
    for archive in archives:
        reader = open_shapefile(archive)
        bx0, by0, bx1, by1 = reader.bbox[:4]
        inside = (ex >= bx0 - 1e-6) & (ex <= bx1 + 1e-6) & (ny >= by0 - 1e-6) & (ny <= by1 + 1e-6)
        if not inside.any():
            continue
        tin = TerrainTin([archive])
        index = np.nonzero(inside & np.isnan(heights))[0]
        heights[index] = tin.sample(ex[index], ny[index])
        sheets.append({"file": archive.name, "triangles": int(len(tin.z)), "samples": int(len(index))})
        print(f"{archive.name}: {len(tin.z)} triangles, {len(index)} samples", flush=True)
        del tin
    missing = int(np.isnan(heights).sum())
    output_tiles = []
    levels = {}
    for tile, start in zip(tiles, offsets[:-1]):
        values = heights[start:start + tile["n"] ** 2]
        if np.isnan(values).all():
            continue
        cm = np.where(np.isnan(values), MISSING, np.round(values * 100))
        if np.nanmax(values) * 100 >= MISSING:
            raise ValueError("Altitude exceeds the encoded range")
        output_tiles.append({"x": tile["x"], "z": tile["z"], "step": tile["step"], "n": tile["n"],
                             "data": encode(cm.astype(np.int64))})
        levels[tile["step"]] = levels.get(tile["step"], 0) + 1
    valid = heights[~np.isnan(heights)]
    result = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "source": {
            "dataset": manifest["datasets"]["terrain"],
            "manifest": str(args.manifest),
            "manifestSha256": sha256_file(args.manifest),
            "sheets": sheets,
            "description": "Bare-earth lidar TIN (approx. 40 points/m², ground without buildings, bridges or vegetation)",
        },
        "coordinateTransform": projection.metadata,
        "origin": origin,
        "verticalReference": "Bpv (Baltic after adjustment), metres; world Y = altitude - baselineAltitude",
        "baselineAltitude": route["baselineAltitude"],
        "tileSize": TILE,
        "levels": [{"maxDistance": None if math.isinf(limit) else limit, "step": step} for limit, step in LEVELS],
        "encoding": "Per tile n×n row-major (x fastest, then +z) uint16 centimetres of altitude, "
                    "delta coded modulo 65536 from the previous sample, little-endian, base64. 65535 = outside the TIN.",
        "statistics": {"tiles": len(output_tiles), "tilesByStep": {str(k): v for k, v in sorted(levels.items())},
                       "samples": int(valid.size), "missingSamples": missing,
                       "minAltitude": float(valid.min()), "maxAltitude": float(valid.max())},
        "tiles": output_tiles,
    }
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    args.output.write_text(text + "\n", "utf-8")
    # Round trip one tile to prove the encoding.
    probe = output_tiles[len(output_tiles) // 2]
    decoded = decode(probe["data"], probe["n"] ** 2)
    if decoded.max() > MISSING:
        raise ValueError("Encoding round trip failed")
    print(json.dumps({**result["statistics"], "bytes": len(text),
                      "sha256": hashlib.sha256(text.encode()).hexdigest()}))


if __name__ == "__main__":
    main()
