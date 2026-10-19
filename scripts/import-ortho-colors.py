#!/usr/bin/env python3
"""Measure roof colours and verify detected crowns with the IPR orthophotos.

IPR Praha publishes its latest colour orthophoto (10 cm, 8 June 2024) and a
colour-infrared one as open image services (CC BY 4.0, datový podklad © IPR
Praha). Tiles of 256 m along the corridor are exported at 0.5 m in S-JTSK and
cached with SHA-256. For every measured building in buildings-3d.json the
median roof colour comes from pixels inside the footprint shrunk by 1 m,
excluding vegetation (NDVI > 0.2 from the infrared image) and deep shadow.
Detected crowns in trees-ipr.json without vegetation (NDVI < 0.15 around the
peak) are removed as structures. Orthophotos are not true orthophotos: tall
roofs lean by up to a few metres, which the shrunken footprint tolerates.

  python3 scripts/import-ortho-colors.py --cache-dir /private/tmp/linka-ortho --download \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif
"""

import argparse
import base64
import colorsys
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
import shapely
from PIL import Image
from shapely.geometry import LineString, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import Projection  # noqa: E402

SERVICES = {
    "rgb": "https://gs-pub.praha.eu/imgs/rest/services/ort/letecke_snimkovani/ImageServer",
    "cir": "https://gs-pub.praha.eu/imgs/rest/services/ort/infracervene_letecke_snimkovani/ImageServer",
}
TILE = 256
PIXEL = 0.5
HAZE_SATURATION = 1.6
HAZE_LIGHTNESS = 0.85


def fetch(url):
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers={"User-Agent": "Linka22 orthophoto colour sampling"}), timeout=120) as r:
                data = r.read()
            Image.open(io.BytesIO(data)).verify()
            return data
        except Exception as error:
            last = error
            time.sleep(1 + 2 * attempt)
    raise RuntimeError(f"Orthophoto read failed: {url}: {last}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--data", type=Path, default=Path("public/data"))
    args = parser.parse_args()
    d = args.data
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    route = json.loads((d / "route22.json").read_text("utf-8"))
    projection = Projection(route, args.grid)
    native_line = LineString([projection.to_native.transform(p["lon"], p["lat"]) for p in route["points"]])
    corridor = native_line.buffer(340)
    minx, miny, maxx, maxy = corridor.bounds
    tiles, images = [], {}
    for tx in range(math.floor(minx / TILE), math.floor(maxx / TILE) + 1):
        for ty in range(math.floor(miny / TILE), math.floor(maxy / TILE) + 1):
            box = shapely.box(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)
            if not box.intersects(corridor):
                continue
            entry = {"x": tx, "y": ty}
            for kind, service in SERVICES.items():
                path = args.cache_dir / f"{kind}_{tx}_{ty}.png"
                url = service + "/exportImage?" + urlencode({
                    "bbox": f"{tx * TILE},{ty * TILE},{(tx + 1) * TILE},{(ty + 1) * TILE}",
                    "bboxSR": 5514, "imageSR": 5514, "size": f"{int(TILE / PIXEL)},{int(TILE / PIXEL)}",
                    "format": "png", "interpolation": "RSP_BilinearInterpolation", "f": "image",
                })
                if args.download and not path.exists():
                    path.write_bytes(fetch(url))
                if not path.exists():
                    raise RuntimeError(f"Missing {path}; run with --download")
                entry[kind] = {"file": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            tiles.append(entry)
    print(f"{len(tiles)} orthophoto tiles", flush=True)

    def tile_arrays(tx, ty):
        key = (tx, ty)
        if key not in images:
            rgb = args.cache_dir / f"rgb_{tx}_{ty}.png"
            if not rgb.exists():
                images[key] = None
            else:
                a = np.asarray(Image.open(rgb).convert("RGB"), dtype=np.float64)
                c = np.asarray(Image.open(args.cache_dir / f"cir_{tx}_{ty}.png").convert("RGB"), dtype=np.float64)
                images[key] = (a, c)
        return images[key]

    def pixels(ex, ny):
        """RGB and NDVI at native points (NaN outside cached tiles)."""
        ex, ny = np.atleast_1d(ex), np.atleast_1d(ny)
        rgb = np.full((len(ex), 3), np.nan)
        ndvi = np.full(len(ex), np.nan)
        tx, ty = np.floor(ex / TILE).astype(int), np.floor(ny / TILE).astype(int)
        for key in set(zip(tx.tolist(), ty.tolist())):
            arrays = tile_arrays(*key)
            if arrays is None:
                continue
            m = (tx == key[0]) & (ty == key[1])
            col = np.clip(((ex[m] - key[0] * TILE) / PIXEL).astype(int), 0, int(TILE / PIXEL) - 1)
            row = np.clip((((key[1] + 1) * TILE - ny[m]) / PIXEL).astype(int), 0, int(TILE / PIXEL) - 1)
            a, c = arrays
            rgb[m] = a[row, col]
            nir, red = c[row, col, 0], c[row, col, 1]
            ndvi[m] = (nir - red) / np.maximum(nir + red, 1)
        return rgb, ndvi

    origin, cos = route["origin"], math.cos(math.radians(route["origin"]["lat"]))
    buildings = json.loads((d / "buildings-3d.json").read_text("utf-8"))
    footprints = {}
    for source in ("city.json", "city-context.json"):
        for b in json.loads((d / source).read_text("utf-8"))["buildings"]:
            footprints[(b["osmId"], round(b["points"][0][0], 7), round(b["points"][0][1], 7))] = b
    coloured = 0
    for record in buildings["buildings"]:
        record.pop("roofColor", None)
        record.pop("roofColorMeasured", None)
        b = footprints.get((record["osmId"], *record["anchor"]))
        if not b:
            continue
        ex, ny = projection.to_native.transform([p[1] for p in b["points"]], [p[0] for p in b["points"]])
        poly = Polygon(np.column_stack([ex, ny]))
        if not poly.is_valid:
            poly = poly.buffer(0)
        core = poly.buffer(-1.0)
        if core.is_empty or core.area < 4:
            continue
        bx0, by0, bx1, by1 = core.bounds
        gx, gy = np.meshgrid(np.arange(bx0, bx1, PIXEL), np.arange(by0, by1, PIXEL))
        gx, gy = gx.ravel(), gy.ravel()
        inside = shapely.contains_xy(core, gx, gy)
        if inside.sum() < 16:
            continue
        rgb, ndvi = pixels(gx[inside], gy[inside])
        luma = rgb @ np.array([0.299, 0.587, 0.114])
        keep = np.isfinite(ndvi) & (ndvi < 0.2) & (luma > 45) & (luma < 245)
        if keep.sum() < max(12, 0.25 * inside.sum()):
            continue
        colour = np.median(rgb[keep], axis=0)
        record["roofColorMeasured"] = "#%02x%02x%02x" % tuple(int(round(v)) for v in colour)
        # Aerial haze lifts and greys every surface; restore saturation and
        # contrast before the colour tints a normalised roof texture.
        h, l, sat = colorsys.rgb_to_hls(*(colour / 255))
        r, g, b = colorsys.hls_to_rgb(h, l * HAZE_LIGHTNESS, min(0.65, sat * HAZE_SATURATION))
        record["roofColor"] = "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in (r, g, b))
        coloured += 1
    buildings["orthophoto"] = {
        "title": "IPR Praha, Ortofotomapa Prahy – poslední snímkování (10 cm), 8. 6. 2024, a infračervená ortofotomapa",
        "services": SERVICES,
        "tilePixelMeters": PIXEL,
        "tiles": tiles,
        "roofColour": "Median sRGB of footprint pixels shrunk by 1 m, without vegetation (NDVI >= 0.2) and shadow "
                      "(roofColorMeasured); roofColor corrects aerial haze with HLS saturation x1.6 (max 0.65) "
                      "and lightness x0.85.",
        "colouredBuildings": coloured,
    }
    (d / "buildings-3d.json").write_text(json.dumps(buildings, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print(f"Roof colours: {coloured}/{len(buildings['buildings'])}", flush=True)

    trees = json.loads((d / "trees-ipr.json").read_text("utf-8"))
    kept, removed = [], 0
    for row in trees.get("detected", []):
        lat, lon = row[0], row[1]
        e, n = projection.to_native.transform(lon, lat)
        offsets = np.array([(dx, dy) for dx in (-0.5, 0, 0.5) for dy in (-0.5, 0, 0.5)])
        _, ndvi = pixels(e + offsets[:, 0], n + offsets[:, 1])
        if np.isfinite(ndvi).any() and np.nanmedian(ndvi) < 0.15:
            removed += 1
            continue
        kept.append(row)
    trees["detected"] = kept
    trees["counts"]["detected"] = len(kept)
    trees["counts"]["detectedInWoodland"] = sum(row[4] for row in kept)
    trees["counts"]["detectedRemovedWithoutVegetation"] = trees["counts"].get(
        "detectedRemovedWithoutVegetation", 0) + removed
    trees.setdefault("surfaceMeasurement", {})["vegetationCheck"] = (
        "Detected crowns need a median NDVI >= 0.15 around the peak in the IPR colour-infrared orthophoto (2024).")
    (d / "trees-ipr.json").write_text(json.dumps(trees, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print(json.dumps({"tiles": len(tiles), "roofColours": coloured, "detectedKept": len(kept), "detectedRemoved": removed}))


if __name__ == "__main__":
    main()
