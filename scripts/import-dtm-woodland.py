#!/usr/bin/env python3
"""Extract surveyed woodland near line 22 from the Prague DTM derived polygons.

The public ZPS derived-polygon packages (see scripts/download-dtm-packages.py)
contain forests (les, 0100000211) and maintained green areas (0100000215),
whose TypUdrzovaneZelene 3 marks a group of trees and shrubs. Individual trees
inside them are not surveyed; the scene plants a deterministic stand.

  python3 scripts/import-dtm-woodland.py --cache-dir /private/tmp/linka-dtm-opl \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif --output public/data/woodland.json
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

from shapely.geometry import LineString, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import load_dtm_module, sha256_file  # noqa: E402

FOREST = "0100000211"
GREEN = "0100000215"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data/woodland.json"))
    parser.add_argument("--distance", type=float, default=300)
    args = parser.parse_args()
    dtm = load_dtm_module()
    route = json.loads(args.route.read_text("utf-8"))
    manifest = json.loads((args.cache_dir / "manifest.json").read_text("utf-8"))
    to_native, to_wgs84, transform = dtm.coordinate_transform(route, args.grid)
    corridor = LineString([to_native.transform(p["lon"], p["lat"]) for p in route["points"]]).buffer(args.distance)
    packages = sorted(manifest["packages"], key=lambda p: (p["kind"] != "snapshot", p["sourceDate"], p["file"]))
    state = {}
    for package in packages:
        path = args.cache_dir / package["file"]
        if sha256_file(path) != package["sha256"]:
            raise ValueError(f"Package checksum differs from the manifest: {path.name}")
        change = package["kind"] == "daily-change"
        with zipfile.ZipFile(path) as archive:
            member = next(name for name in archive.namelist() if name.endswith(".xml"))
            stack, group = [], None
            for event, element in ET.iterparse(archive.open(member), events=("start", "end")):
                if event == "start":
                    stack.append(element)
                    continue
                name = dtm.local_name(element)
                if name == "ObjektovyTypNazev":
                    group = (element.get("code_base"), element.get("code_suffix"))
                if name == "ZaznamObjektu":
                    base, suffix = group
                    if base in (FOREST, GREEN) and suffix == "03":
                        attributes = dtm.leaf_attributes(dtm.descendant(element, "AtributyObjektu"))
                        key = attributes.get("ID")
                        action_node = dtm.descendant(element, "ZapisObjektu")
                        action = (action_node.text or "").strip() if action_node is not None else "r"
                        if change and action == "d":
                            state.pop(key, None)
                        elif not (change and action == "r" and key in state):
                            wooded = base == FOREST or attributes.get("TypUdrzovaneZelene") == "3"
                            kept = None
                            if wooded:
                                for polygon in dtm.polygon_geometry(element):
                                    rings = polygon["rings"]
                                    shape = Polygon([p[:2] for p in rings[0]], [[p[:2] for p in r] for r in rings[1:]])
                                    if shape.intersects(corridor):
                                        kept = kept or []
                                        kept.append(rings)
                            if kept:
                                state[key] = ("forest" if base == FOREST else "treeGroup", kept)
                            else:
                                state.pop(key, None)
                    stack[-2].remove(element)
                stack.pop()
        print(f"{package['file']}: {len(state)} wooded areas", flush=True)

    def project(ring):
        lon, lat = to_wgs84.transform([p[0] for p in ring], [p[1] for p in ring])
        return [[round(a, 7), round(o, 7)] for a, o in zip(lat, lon)]

    areas, counts = [], {}
    for key, (kind, polygons) in sorted(state.items()):
        for part, rings in enumerate(polygons):
            areas.append({"id": f"dtm/{key}/{part}", "kind": kind, "points": project(rings[0]),
                          "holes": [project(ring) for ring in rings[1:]]})
            counts[kind] = counts.get(kind, 0) + 1
    result = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "source": {"name": manifest["sourceName"], "content": manifest["content"],
                   "snapshotDate": manifest["snapshotDate"], "latestDailyUpdateDate": manifest["latestDailyUpdateDate"],
                   "packages": [{"file": p["file"], "sha256": p["sha256"]} for p in packages]},
        "coordinateTransform": transform,
        "selection": f"Forest (0100000211) and tree/shrub groups (0100000215, TypUdrzovaneZelene 3) "
                     f"intersecting {args.distance:g} m of the PID shape; complete polygons",
        "limitations": ["Individual trees inside these areas are not surveyed; the scene plants an estimated stand."],
        "counts": counts,
        "areas": areas,
    }
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    args.output.write_text(text + "\n", "utf-8")
    print(json.dumps({"areas": len(areas), **counts, "bytes": len(text),
                      "sha256": hashlib.sha256(text.encode()).hexdigest()}))


if __name__ == "__main__":
    main()
