#!/usr/bin/env python3
"""Replace the route's satellite elevation profile with the IPR lidar terrain.

Samples public/data/terrain-lidar.json every 2 m along the official PID shape,
bridges the documented Vltava crossing with the upper hull of the measured
abutments (bare-earth lidar contains the river, not the deck) and applies a
6 m Gaussian to remove single-sample curb and drain noise. The result is stored
as a dense profile; points and stops keep their raw lidar sample.

  python3 scripts/apply-lidar-route-profile.py
"""

import argparse
import base64
import json
import math
from pathlib import Path

import numpy as np

SPACING = 2.0
PROFILE_SPACING = 5.0
SIGMA = 6.0


class Lidar:
    def __init__(self, data):
        self.size = data["tileSize"]
        self.tiles = {(tile["x"], tile["z"]): tile for tile in data["tiles"]}
        self.grids = {}

    def grid(self, key):
        if key not in self.grids:
            tile = self.tiles[key]
            values = np.cumsum(np.frombuffer(base64.b64decode(tile["data"]), dtype="<u2").astype(np.int64)) & 0xFFFF
            grid = np.where(values == 0xFFFF, np.nan, values / 100.0)
            self.grids[key] = grid.reshape(tile["n"], tile["n"])
        return self.grids[key]

    def altitude(self, x, z):
        key = (math.floor(x / self.size), math.floor(z / self.size))
        tile = self.tiles[key]
        grid = self.grid(key)
        gx = (x - key[0] * self.size) / tile["step"]
        gz = (z - key[1] * self.size) / tile["step"]
        ix = min(tile["n"] - 2, int(gx))
        iz = min(tile["n"] - 2, int(gz))
        fx, fz = gx - ix, gz - iz
        value = (grid[iz, ix] * (1 - fx) * (1 - fz) + grid[iz, ix + 1] * fx * (1 - fz)
                 + grid[iz + 1, ix] * (1 - fx) * fz + grid[iz + 1, ix + 1] * fx * fz)
        if not math.isfinite(value):
            raise ValueError(f"Route leaves the lidar survey at {x:.1f}, {z:.1f}")
        return float(value)


def upper_hull(s, h):
    hull = []
    for point in zip(s, h):
        while len(hull) >= 2:
            (s1, h1), (s2, h2) = hull[-2], hull[-1]
            if (s2 - s1) * (point[1] - h1) - (h2 - h1) * (point[0] - s1) >= 0:
                hull.pop()
            else:
                break
        hull.append(point)
    hs, hh = zip(*hull)
    return np.interp(s, hs, hh)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--lidar", type=Path, default=Path("public/data/terrain-lidar.json"))
    args = parser.parse_args()
    route = json.loads(args.route.read_text("utf-8"))
    lidar_data = json.loads(args.lidar.read_text("utf-8"))
    lidar = Lidar(lidar_data)
    origin = route["origin"]
    if origin != lidar_data["origin"]:
        raise ValueError("Lidar grid and route use different projection origins")
    cos = math.cos(math.radians(origin["lat"]))

    def world(lat, lon):
        return (lon - origin["lon"]) * 111320 * cos, -(lat - origin["lat"]) * 111320

    points = [(*world(p["lat"], p["lon"]), p["distance"]) for p in route["points"]]
    stations, raw = [], []
    for (x1, z1, s1), (x2, z2, s2) in zip(points, points[1:]):
        steps = max(1, int(math.ceil((s2 - s1) / SPACING)))
        for k in range(steps):
            t = k / steps
            stations.append(s1 + (s2 - s1) * t)
            raw.append(lidar.altitude(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t))
    stations.append(points[-1][2])
    raw.append(lidar.altitude(points[-1][0], points[-1][1]))
    stations = np.array(stations)
    profile = np.array(raw)
    source = route["elevationSource"]
    bridge = source.get("bridgeInterpolationIndices")
    bridges = []
    if bridge:
        start = route["points"][bridge[0]]["distance"] - 40
        end = route["points"][bridge[1]]["distance"] + 60
        window = (stations >= start) & (stations <= end)
        profile[window] = upper_hull(stations[window], profile[window])
        bridges.append([round(start, 1), round(end, 1)])
    smoothed = np.empty_like(profile)
    for i, s in enumerate(stations):
        near = np.abs(stations - s) <= 3 * SIGMA
        weights = np.exp(-0.5 * ((stations[near] - s) / SIGMA) ** 2)
        smoothed[i] = float((profile[near] * weights).sum() / weights.sum())
    dense = np.arange(0, stations[-1], PROFILE_SPACING).tolist() + [float(stations[-1])]
    dense_heights = np.interp(dense, stations, smoothed)
    grades = np.gradient(dense_heights, dense)
    for point, (x, z, s) in zip(route["points"], points):
        point["terrainElevation"] = round(lidar.altitude(x, z), 2)
        point["elevation"] = round(float(np.interp(s, stations, smoothed)), 2)
    for stop in route["stops"]:
        stop["terrainElevation"] = round(lidar.altitude(*world(stop["lat"], stop["lon"])), 2)
    route["profile"] = [[round(s, 2), round(float(h), 2)] for s, h in zip(dense, dense_heights)]
    route["elevationSource"] = {
        "title": "IPR Praha, Model terénu 3D (lidar bare-earth TIN) via public/data/terrain-lidar.json",
        "url": lidar_data["source"]["dataset"]["landingPage"],
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "resolutionMeters": min(level["step"] for level in lidar_data["levels"]),
        "units": "metres above sea level (Bpv)",
        "processing": (f"terrainElevation: lidar terrain at the GTFS point. elevation/profile: lidar sampled every "
                       f"{SPACING:g} m along the PID shape, upper hull across the Vltava bridge window, Gaussian "
                       f"sigma {SIGMA:g} m; profile every {PROFILE_SPACING:g} m. Surveyed DTM street heights still "
                       "take precedence at runtime."),
        "bridgeInterpolationIndices": bridge,
        "bridgeWindows": bridges,
        "maximumGradePercent": round(float(np.abs(grades).max()) * 100, 2),
    }
    route["attribution"] = route["attribution"].replace(
        "Výšková data: Copernicus DEM / Open-Meteo, CC BY 4.0; profil vyhlazen pro simulátor.",
        "Výšková data: lidarový model terénu IPR Praha, datový podklad © IPR Praha, CC BY 4.0; most přes Vltavu přemostěn.")
    args.route.write_text(json.dumps(route, ensure_ascii=False, separators=(",", ":")), "utf-8")
    print(json.dumps({"profile": len(route["profile"]), "maximumGradePercent": route["elevationSource"]["maximumGradePercent"],
                      "start": route["profile"][0], "end": route["profile"][-1]}))


if __name__ == "__main__":
    main()
