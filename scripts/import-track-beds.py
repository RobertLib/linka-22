#!/usr/bin/env python3
"""Measure the real tram track bed (grass, ballast or paved) from IPR orthophotos.

Street photographs along line 22 show three kinds of track bed: grassed
reserved tracks (Bělohorská, Vršovická), open ballast with sleepers (Malý
Břevnov, Vypich) and tracks embedded in setts or asphalt. Neither OSM nor the
DTM classes record this, so it is measured from the IPR Praha colour
orthophoto (10 cm, 8 June 2024) and its colour-infrared twin (CC BY 4.0,
datový podklad © IPR Praha).

Every surveyed DTM track axis within 30 m of the route (the rendered rails;
OSM tracks only where no axis is surveyed, bridge decks excluded) is sampled
each 2 m. A window
4 m long and 2.4 m wide (rails and sleeper ends) is read at 0.2 m; samples
under a measured tree crown are filled from their neighbours along the track:

- vegetation: NIR/red index of the infrared image. June 2024 was dry, so a
  grassed bed is often straw-coloured; the index is compared with the paved
  surfaces of the same tile instead of a fixed NDVI threshold;
- sleepers: spectral power of the along-track luminance profile at the
  0.5–0.85 m sleeper pitch relative to 0.45–3 m;
- warmth (red minus blue) and luminance; deep shadow stays unknown.

Short runs are smoothed along each track and the result is written as 2 m
samples. Paved samples keep the existing OSM/historic sett-or-asphalt choice.

  python3 scripts/import-track-beds.py --cache-dir /private/tmp/linka-trackbed --download \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif
"""

import argparse
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
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import Projection  # noqa: E402

SERVICES = {
    "rgb": "https://gs-pub.praha.eu/imgs/rest/services/ort/letecke_snimkovani/ImageServer",
    "cir": "https://gs-pub.praha.eu/imgs/rest/services/ort/infracervene_letecke_snimkovani/ImageServer",
}
TILE = 128
PIXEL = 0.2
STEP = 2.0
HALF_LENGTH = 2.0
HALF_WIDTH = 1.2
KINDS = ["grass", "ballast", "paved"]


def fetch(url):
    last = None
    for attempt in range(5):
        try:
            with urlopen(Request(url, headers={"User-Agent": "Linka22 track bed measurement"}), timeout=120) as r:
                data = r.read()
            Image.open(io.BytesIO(data)).verify()
            return data
        except Exception as error:  # noqa: BLE001 - retried network read
            last = error
            time.sleep(1 + 2 * attempt)
    raise RuntimeError(f"Orthophoto read failed: {url}: {last}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--data", type=Path, default=Path("public/data"))
    parser.add_argument("--dump-features", type=Path)
    args = parser.parse_args()
    d = args.data
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    route = json.loads((d / "route22.json").read_text("utf-8"))
    network = json.loads((d / "street-network.json").read_text("utf-8"))
    projection = Projection(route, args.grid)
    native_route = LineString([projection.to_native.transform(p["lon"], p["lat"]) for p in route["points"]])
    near_route = native_route.buffer(30)

    def native_line(points):
        ex, ny = projection.to_native.transform([p[1] for p in points], [p[0] for p in points])
        return LineString(list(zip(ex, ny)))

    def parts(geometry):
        if geometry.is_empty:
            return []
        return [g for g in getattr(geometry, "geoms", [geometry]) if g.geom_type == "LineString" and g.length >= 4]

    # The rendered rails follow the surveyed DTM track axes; OSM tracks only
    # fill gaps. Bridge decks (Most Legií) carry the tracks above the island's
    # trees and stay unmeasured.
    osm_rails, bridges = [], []
    for rail in network["rails"]:
        tags = rail.get("tags", {})
        if rail.get("railway") != "tram" or tags.get("tunnel") in ("yes", "building_passage"):
            continue
        line = native_line(rail["points"])
        if tags.get("bridge"):
            bridges.append(line.buffer(4))
        elif line.length >= 4 and line.intersects(near_route):
            osm_rails.append((rail["osmId"], line))
    bridge_mask = shapely.union_all(bridges) if bridges else shapely.GeometryCollection()
    axes = json.loads((d / "dtm-track-axes.json").read_text("utf-8"))
    axis_lines = [
        native_line(feature["points"]) for feature in axes["features"] if feature.get("kind") == "tram-axis"
    ]
    # Axes are split into short survey pieces; chain the touching pieces of
    # each track so smoothing along it sees whole runs between crossings.
    merged = shapely.line_merge(shapely.union_all([line for line in axis_lines if line.intersects(near_route)]))
    tracks = [("dtm", part) for part in parts(merged.difference(bridge_mask))]
    surveyed = shapely.union_all([line.buffer(3) for _, line in tracks]) if tracks else shapely.GeometryCollection()
    for osm_id, line in osm_rails:
        tracks += [(osm_id, part) for part in parts(line.difference(surveyed))]
    corridor = shapely.union_all([line.buffer(HALF_WIDTH + 1) for _, line in tracks])

    tiles = []
    for tx in range(math.floor(corridor.bounds[0] / TILE), math.floor(corridor.bounds[2] / TILE) + 1):
        for ty in range(math.floor(corridor.bounds[1] / TILE), math.floor(corridor.bounds[3] / TILE) + 1):
            if not shapely.box(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE).intersects(corridor):
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
    print(f"{len(tracks)} tram track pieces, {len(tiles)} orthophoto tiles", flush=True)

    images = {}

    def tile_arrays(key):
        if key not in images:
            rgb = args.cache_dir / f"rgb_{key[0]}_{key[1]}.png"
            if not rgb.exists():
                images[key] = None
            else:
                a = np.asarray(Image.open(rgb).convert("RGB"), dtype=np.float32)
                c = np.asarray(Image.open(args.cache_dir / f"cir_{key[0]}_{key[1]}.png").convert("RGB"), dtype=np.float32)
                images[key] = (a, c)
        return images[key]

    def pixels(ex, ny):
        rgb = np.full(ex.shape + (3,), np.nan, dtype=np.float32)
        cir = np.full(ex.shape + (3,), np.nan, dtype=np.float32)
        tx, ty = np.floor(ex / TILE).astype(int), np.floor(ny / TILE).astype(int)
        size = int(TILE / PIXEL)
        for key in set(zip(tx.ravel().tolist(), ty.ravel().tolist())):
            arrays = tile_arrays(key)
            if arrays is None:
                continue
            m = (tx == key[0]) & (ty == key[1])
            col = np.clip(((ex[m] - key[0] * TILE) / PIXEL).astype(int), 0, size - 1)
            row = np.clip((((key[1] + 1) * TILE - ny[m]) / PIXEL).astype(int), 0, size - 1)
            rgb[m] = arrays[0][row, col]
            cir[m] = arrays[1][row, col]
        return rgb, cir

    along = np.arange(-HALF_LENGTH, HALF_LENGTH, PIXEL) + PIXEL / 2
    across = np.arange(-HALF_WIDTH, HALF_WIDTH, PIXEL) + PIXEL / 2
    U, V = np.meshgrid(along, across)
    window = np.hanning(len(along))
    freqs = np.fft.rfftfreq(len(along), PIXEL)
    sleeper_band = (freqs > 1 / 0.85) & (freqs < 1 / 0.5)
    reference_band = (freqs > 1 / 3.0) & (freqs < 1 / 0.45)

    samples = []
    for track_id, line in tracks:
        count = max(1, int(line.length // STEP))
        for i in range(count + 1):
            dist = min(line.length, i * STEP)
            p = line.interpolate(dist)
            a = line.interpolate(max(0, dist - 1.5))
            b = line.interpolate(min(line.length, dist + 1.5))
            tx, ty = b.x - a.x, b.y - a.y
            norm = math.hypot(tx, ty) or 1
            tx, ty = tx / norm, ty / norm
            ex = p.x + U * tx - V * ty
            ny = p.y + U * ty + V * tx
            rgb, cir = pixels(ex, ny)
            if np.isnan(rgb).any():
                continue
            lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
            nir, red = cir[..., 0], cir[..., 1]
            index = (nir - red) / np.maximum(nir + red, 1)
            profile = lum.mean(axis=0)
            spectrum = np.abs(np.fft.rfft((profile - profile.mean()) * window)) ** 2
            lat, lon = projection.native_to_latlon(p.x, p.y)
            samples.append({
                "track": track_id, "line": id(line), "distance": dist, "lat": float(lat), "lon": float(lon),
                "e": p.x, "n": p.y,
                "index": float(np.median(index)), "index75": float(np.percentile(index, 75)),
                "lum": float(np.median(lum)), "warm": float(np.median(rgb[..., 0] - rgb[..., 2])),
                "sleepers": float(spectrum[sleeper_band].sum() / max(spectrum[reference_band].sum(), 1e-6)),
                "texture": float(np.std(lum)),
            })
    print(f"{len(samples)} track samples", flush=True)
    if args.dump_features:
        args.dump_features.write_text(json.dumps(samples))

    # The infrared index has a per-flight offset. Paved track (setts,
    # asphalt, concrete panels) is the commonest and least vegetated class,
    # so its typical index is the local reference for each 512 m block.
    blocks = {}
    for s in samples:
        if s["lum"] > 70:
            blocks.setdefault((int(s["e"] // 512), int(s["n"] // 512)), []).append(s["index"])
    global_paved = float(np.percentile([s["index"] for s in samples if s["lum"] > 70], 25))

    def paved_reference(s):
        values = blocks.get((int(s["e"] // 512), int(s["n"] // 512)), [])
        return float(np.percentile(values, 20)) if len(values) >= 40 else global_paved

    # Street trees overhanging the track (Ječná, Karlovo náměstí) are
    # vegetation in the infrared image but say nothing about the bed below.
    trees = json.loads((d / "trees-ipr.json").read_text("utf-8"))
    crowns = []
    for lat, lon, _, _, height in trees["trees"]:
        crowns.append((lat, lon, min(8.0, max(2.5, 0.35 * (height or 10)))))
    for lat, lon, height, radius, _ in trees["detected"]:
        if height >= 4:
            crowns.append((lat, lon, radius))
    crown_e, crown_n = projection.to_native.transform([c[1] for c in crowns], [c[0] for c in crowns])
    crown_tree = shapely.STRtree([shapely.Point(e, n).buffer(c[2], 8) for e, n, c in zip(crown_e, crown_n, crowns)])
    covered = crown_tree.query(shapely.points([s["e"] for s in samples], [s["n"] for s in samples]), predicate="intersects")
    under_canopy = set(covered[0].tolist())

    for i, s in enumerate(samples):
        lift = s["index"] - paved_reference(s)
        s["lift"] = lift
        s["canopy"] = i in under_canopy
        if s["lum"] < 70 or s["canopy"] or lift > 0.3:
            s["kind"] = None
        elif lift > 0.075 or (lift > 0.045 and s["warm"] > 10):
            s["kind"] = "grass"
        elif s["sleepers"] > 0.55 and s["warm"] > 8 and s["texture"] > 6:
            s["kind"] = "ballast"
        else:
            s["kind"] = "paved"

    # Smooth along each track: majority of 7 neighbours (14 m), then fill
    # shadowed samples from the nearest classified neighbour.
    by_track = {}
    for s in samples:
        by_track.setdefault(s["line"], []).append(s)
    for run in by_track.values():
        run.sort(key=lambda s: s["distance"])
        raw = [s["kind"] for s in run]
        for i, s in enumerate(run):
            votes = [k for k in raw[max(0, i - 3):i + 4] if k]
            s["kind"] = max(set(votes), key=votes.count) if votes else None
        for i, s in enumerate(run):
            if s["kind"] is None:
                for offset in range(1, len(run)):
                    near = [run[j]["kind"] for j in (i - offset, i + offset) if 0 <= j < len(run) and run[j]["kind"]]
                    if near:
                        s["kind"] = near[0]
                        break
            s["kind"] = s["kind"] or "paved"
        # Grassed and ballasted beds run between crossings for tens of
        # metres; shorter islands are leftovers of canopy or shadow.
        i = 0
        while i < len(run):
            j = i
            while j < len(run) and run[j]["kind"] == run[i]["kind"]:
                j += 1
            minimum = {"grass": 22, "ballast": 10}.get(run[i]["kind"], 0)
            if j - i < minimum:
                before = run[i - 1]["kind"] if i else None
                after = run[j]["kind"] if j < len(run) else None
                fill = before if before == after and before else "paved"
                for k in range(i, j):
                    run[k]["kind"] = fill
            i = j

    counts = {k: sum(1 for s in samples if s["kind"] == k) for k in KINDS}
    counts["underCanopy"] = len(under_canopy)
    result = {
        "attribution": "Datový podklad © IPR Praha (ortofoto 2024, infračervené ortofoto), CC BY 4.0; polohy vzorků na osách kolejí veřejné DI DTM Prahy (viz dtm-track-axes.json) a mimo ně na kolejích © přispěvatelé OpenStreetMap, ODbL 1.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "orthophoto": {
            "title": "IPR Praha, Ortofotomapa Prahy – poslední snímkování (10 cm), 8. 6. 2024, a infračervená ortofotomapa",
            "services": SERVICES,
            "tilePixelMeters": PIXEL,
            "tileMeters": TILE,
            "tiles": tiles,
        },
        "method": (
            f"Surveyed DTM track axes (OSM tracks where none) within 30 m of the route, without bridge decks, sampled every {STEP} m; a {2 * HALF_LENGTH} x {2 * HALF_WIDTH} m "
            "window at 0.2 m; samples under measured tree crowns (IPR greenery, DSM detection) or with a "
            "canopy-like index are unknown. grass: NIR/red index above the paved reference of its 512 m block by 0.075 "
            "(0.045 when warm); ballast: sleeper pitch power > 0.55 with warm, textured stones; otherwise paved. "
            "Majority of 7 neighbours along each track; shadow and canopy filled from neighbours; grass runs under "
            "44 m and ballast runs under 20 m revert to paved."
        ),
        "kinds": KINDS,
        "step": STEP,
        "counts": counts,
        "samples": [[round(s["lat"], 7), round(s["lon"], 7), KINDS.index(s["kind"])] for s in samples],
    }
    (d / "track-beds.json").write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", "utf-8")
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
