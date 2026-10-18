#!/usr/bin/env python3
"""Extract surveyed walls, fences, railings, barriers and small structures.

Reads the public ZPS drawing packages of the Prague DTM ("ZpsKresba", see
scripts/download-dtm-packages.py --content zps-drawing) and keeps complete
objects near line 22:

* lines: wall (zeď, with TypZdi), fence (plot, DruhPlotu), railing (zábradlí),
  noise barrier, crash barrier (svodidlo) and flood-wall lines;
* points: fountains, statues and monuments (drobná kulturní stavba), crosses
  and chapels (drobná sakrální stavba), public wells, technological poles and
  carriers of technical equipment (advertising columns, billboards, flag poles).

Snapshots are read first, then daily changes chronologically with their
insert/update/delete operations. Coordinates use the authoritative ČÚZK grid
transform of the street-surface importer. Classes and codelists follow the
official JVF DTM 1.4.3 XSD (xsd/common/atributy.xsd).

  python3 scripts/import-dtm-street-features.py --cache-dir /private/tmp/linka-dtm-drawing \
    --grid /path/to/cz_cuzk_table_-y-x_3_v1710.tif --output public/data/street-features.json
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET
import zipfile

from shapely.geometry import LineString, Point
from shapely import prepared

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ipr_3d_sources import load_dtm_module, sha256_file  # noqa: E402

LINES = {
    "0100000168": ("wall", "TypZdi"),
    "0100000162": ("fence", "DruhPlotu"),
    "0100000199": ("railing", None),
    "0100000319": ("noiseBarrier", None),
    "0100000318": ("crashBarrier", "TypSvodidla"),
    "0100000085": ("floodBarrier", "TypProtipovodnoveZabrany"),
}
POINTS = {
    "0100000159": ("monument", "TypDrobneKulturniStavby"),
    "0100000154": ("shrine", "TypDrobneSakralniStavby"),
    "0100000084": ("well", None),
    "0100000186": ("pole", None),
    "0100000201": ("carrier", "TypNosiceTechnickehoZarizeni"),
}
CODELISTS = {
    "TypZdi": {"1": "free-standing", "2": "retaining", "3": "revetment", "4": "city-wall"},
    "DruhPlotu": {"1": "wood", "2": "wire", "3": "metal", "4": "masonry", "5": "hedge", "98": "other"},
    "TypSvodidla": {"1": "single", "2": "double"},
    "TypProtipovodnoveZabrany": {"1": "dam", "2": "embankment", "3": "wall", "4": "mobile-foundation", "98": "other"},
    "TypDrobneKulturniStavby": {"1": "fountain-basin", "2": "fountain", "3": "monument", "4": "statue",
                                "5": "cairn", "6": "bell-tower"},
    "TypDrobneSakralniStavby": {"1": "cross", "2": "wayside-shrine", "3": "chapel"},
    "TypNosiceTechnickehoZarizeni": {"1": "information-board", "2": "billboard", "3": "camera-pole",
                                     "4": "advertising-column", "5": "flag-pole", "6": "combined", "98": "other"},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--output", type=Path, default=Path("public/data/street-features.json"))
    parser.add_argument("--distance", type=float, default=160)
    args = parser.parse_args()
    dtm = load_dtm_module()
    route = json.loads(args.route.read_text("utf-8"))
    manifest = json.loads((args.cache_dir / "manifest.json").read_text("utf-8"))
    to_native, to_wgs84, transform = dtm.coordinate_transform(route, args.grid)
    corridor = prepared.prep(LineString(
        [to_native.transform(p["lon"], p["lat"]) for p in route["points"]]).buffer(args.distance))
    packages = sorted(manifest["packages"], key=lambda p: (p["kind"] != "snapshot", p["sourceDate"], p["file"]))
    state, operations = {}, {}
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
                    wanted = (LINES if suffix == "02" else POINTS if suffix == "01" else {}).get(base)
                    if wanted:
                        attributes = dtm.leaf_attributes(dtm.descendant(element, "AtributyObjektu"))
                        object_id = attributes.get("ID")
                        action_node = dtm.descendant(element, "ZapisObjektu")
                        action = (action_node.text or "").strip() if action_node is not None else "r"
                        operations[action] = operations.get(action, 0) + 1
                        key = f"{base}/{object_id}"
                        if change and action == "d":
                            state.pop(key, None)
                        elif not (change and action == "r" and key in state):
                            positions = [node for node in element.iter()
                                         if dtm.local_name(node) in ("pos", "posList")]
                            if positions:
                                node = positions[0]
                                dimension = int(node.get("srsDimension") or 3)
                                values = [float(v) for v in (node.text or "").split()]
                                coordinates = [values[i:i + dimension] for i in range(0, len(values), dimension)]
                                geometry = LineString([c[:2] for c in coordinates]) if len(coordinates) > 1 \
                                    else Point(coordinates[0][:2])
                                if corridor.intersects(geometry):
                                    state[key] = (base, suffix, attributes, coordinates)
                                else:
                                    state.pop(key, None)
                    stack[-2].remove(element)
                stack.pop()
        print(f"{package['file']}: {len(state)} features", flush=True)
    lines, points, counts = [], [], {}
    for key, (base, suffix, attributes, coordinates) in sorted(state.items()):
        kind, attribute = (LINES if suffix == "02" else POINTS)[base]
        subtype = CODELISTS.get(attribute, {}).get(attributes.get(attribute)) if attribute else None
        if kind == "floodBarrier" and subtype != "wall":
            continue
        lon, lat = to_wgs84.transform([c[0] for c in coordinates], [c[1] for c in coordinates])
        heights = [round(c[2], 2) if len(c) > 2 and c[2] > 0 else None for c in coordinates]
        record = {
            "id": attributes.get("ID"),
            "kind": kind,
            "type": subtype,
            "precision": {"position": attributes.get("TridaPresnostiPoloha"),
                          "height": attributes.get("TridaPresnostiVyska")},
            "level": int(attributes.get("UrovenUmisteniObjektuZPS") or 0),
        }
        label = kind + (f":{subtype}" if subtype else "")
        counts[label] = counts.get(label, 0) + 1
        if suffix == "02":
            record["points"] = [[round(a, 7), round(o, 7)] for a, o in zip(lat, lon)]
            record["elevations"] = heights
            lines.append(record)
        else:
            record["lat"], record["lon"] = round(lat[0], 7), round(lon[0], 7)
            record["elevation"] = heights[0]
            points.append(record)
    result = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "source": {
            "name": manifest["sourceName"],
            "content": manifest["content"],
            "snapshotDate": manifest["snapshotDate"],
            "latestDailyUpdateDate": manifest["latestDailyUpdateDate"],
            "packages": [{"file": p["file"], "sha256": p["sha256"], "url": p["url"]} for p in packages],
            "schema": "https://www.cuzk.gov.cz/DMVS/JVF-DTM/xsd-1_4_3_navrh.aspx",
        },
        "coordinateTransform": transform,
        "selection": f"Complete objects intersecting {args.distance:g} m of the PID shape",
        "verticalReference": "Bpv metres; null where the source height is zero or missing",
        "operations": operations,
        "counts": dict(sorted(counts.items())),
        "lines": lines,
        "points": points,
    }
    text = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    args.output.write_text(text + "\n", "utf-8")
    print(json.dumps({"lines": len(lines), "points": len(points), "bytes": len(text),
                      "sha256": hashlib.sha256(text.encode()).hexdigest(), **counts}))


if __name__ == "__main__":
    main()
