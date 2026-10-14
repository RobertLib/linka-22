#!/usr/bin/env python3
"""Prepare a separate horizontal tram-axis candidate from public JVF DTM DI.

Uses the same verified Czech projected correction grid as the street importer.
Only individual track axes (0027), position class 3 and terrestrial geodetic
acquisition 1 qualify for horizontal refinement. Complete native lines remain
unsimplified. Source zeros are retained in the native archive, never elevations.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location("dtm_streets", Path(__file__).with_name("import-dtm-street-surfaces.py"))
dtm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dtm)
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

CLASSES = {"0100000027": "osa_koleje_tramvajove_drahy-linie.xsd",
           "0100000026": "osa_tramvajove_drahy-linie.xsd"}
PUBLIC_DI_RULES = "https://www.cuzk.gov.cz/DMVS/Poskytovani-dat.aspx"


def iter_records(stream, header, inventory):
    stack, groups = [], {}
    for event, element in ET.iterparse(stream, events=("start", "end")):
        name = dtm.local_name(element)
        if event == "start":
            stack.append(element)
            continue
        if name == "ObjektovyTypNazev":
            groups[id(stack[-2])] = {"base": element.get("code_base"), "suffix": element.get("code_suffix"),
                                      "name": (element.text or "").strip()}
        if len(stack) <= 3 and name in {"VerzeJVFDTM", "DatumZapisu", "TypZapisu"}:
            header[name] = (element.text or "").strip()
        if name == "ZaznamObjektu":
            group = groups.get(id(stack[-3]))
            if group is None:
                raise ValueError("Source object has no declared class")
            inventory[group["base"] + "/" + group["suffix"]] += 1
            # Observe operations from every class, so a class-changing update
            # cannot leave a stale previously selected axis in the candidate.
            yield group, element
            stack[-2].remove(element)
        stack.pop()


def curve_geometry(record):
    property_node = dtm.descendant(record, "curveProperty")
    if property_node is None:
        raise ValueError("An axis needs a genuine curveProperty, never a definition point")
    lines = [node for node in property_node.iter() if dtm.local_name(node) == "LineString"]
    if len(lines) != 1:
        raise ValueError("Unsupported axis GML curve: a lossless linear importer requires one LineString")
    line = lines[0]
    crs = dtm.epsg_name(line.get("srsName"))
    points, text = dtm.linear_positions(line, int(line.get("srsDimension", "3")))
    if len(points) < 2 or any(len(point) != 3 for point in points):
        raise ValueError("Axis geometry must retain its declared XYZ tuples")
    return {"crs": crs, "points": points, "positionText": text}


def import_axes(inputs, route, snapshot_date, changes=None, package_metadata=None,
                grid_path=None, requested_as_of=None, corridor_meters=100):
    to_native, to_wgs84, transform = dtm.coordinate_transform(route, grid_path)
    corridor = LineString([to_native.transform(point["lon"], point["lat"]) for point in route["points"]]).buffer(corridor_meters)
    packages = [(Path(path), "snapshot") for path in inputs] + [(Path(path), "daily-change") for path in (changes or [])]
    metadata = package_metadata or {}
    dates = [metadata.get(path.name, {}).get("sourceDate", path.name) for path, kind in packages if kind == "daily-change"]
    if dates != sorted(dates):
        raise ValueError("Daily DI changes must be applied chronologically")
    state, fingerprints, sources = {}, {}, []
    inventory, operations, applied = Counter(), Counter(), Counter()
    for path, mode in packages:
        package_bytes = path.read_bytes()
        digest = hashlib.sha256(package_bytes).hexdigest()
        manifest = metadata.get(path.name, {})
        if manifest.get("sha256", digest) != digest:
            raise ValueError("Source package checksum differs from manifest: " + path.name)
        archive = zipfile.ZipFile(path) if zipfile.is_zipfile(path) else None
        members = [name for name in archive.namelist() if name.lower().endswith(".xml")] if archive else [path.name]
        if not members:
            raise ValueError("No XML in source package")
        for member in members:
            header = {}
            with (archive.open(member) if archive else path.open("rb")) as stream:
                for group, record in iter_records(stream, header, inventory):
                    attributes = dtm.leaf_attributes(dtm.descendant(record, "AtributyObjektu"))
                    object_id = attributes.get("ID")
                    action_node = dtm.descendant(record, "ZapisObjektu")
                    action = (action_node.text or "").strip() if action_node is not None else ""
                    if not object_id or action not in {"r", "i", "u", "d"}:
                        raise ValueError("DI source ID or operation is missing/unknown")
                    selected_class = group["base"] in CLASSES and group["suffix"] == "02"
                    if selected_class:
                        operations[mode + "/" + action] += 1
                    if mode == "daily-change":
                        if action == "d":
                            if state.pop(object_id, None) is not None:
                                applied["deleted"] += 1
                            fingerprints.pop(object_id, None)
                            continue
                        if action == "r" and object_id in state:
                            applied["existingReferenceKept"] += 1
                            continue
                        if action in {"i", "u"}:
                            if state.pop(object_id, None) is not None:
                                applied["replaced"] += 1
                            fingerprints.pop(object_id, None)
                    if not selected_class:
                        continue
                    curve = curve_geometry(record)
                    shape = LineString([point[:2] for point in curve["points"]])
                    if shape.is_empty or shape.length <= 0 or not shape.intersects(corridor):
                        continue
                    fingerprint = hashlib.sha256(json.dumps({"class": group["base"], "curve": curve, "attributes": attributes}, sort_keys=True).encode()).hexdigest()
                    if object_id in fingerprints:
                        if fingerprints[object_id] != fingerprint:
                            raise ValueError("Conflicting duplicate DI source object " + object_id)
                        continue
                    fingerprints[object_id] = fingerprint
                    heights = [point[2] if point[2] > 0 else None for point in curve["points"]]
                    position = int(attributes["TridaPresnostiPoloha"])
                    acquisition = int(attributes["ZpusobPorizeniDI"])
                    usable = group["base"] == "0100000027" and position == 3 and acquisition == 1
                    partial = attributes.get("NeuplnaData")
                    if partial not in {"true", "false"}:
                        raise ValueError("Unknown DI incomplete-data flag")
                    identity = f"dtm-track/{object_id}/0"
                    feature = {
                        "id": identity, "objectId": object_id, "kind": "tram-axis", "dtmClass": group["base"],
                        "dtmSuffix": group["suffix"], "dtmName": group["name"], "dtmSchema": CLASSES[group["base"]],
                        "points": [[lat, lon] for lon, lat in [to_wgs84.transform(*point[:2]) for point in curve["points"]]],
                        "elevations": heights, "level": int(attributes["UrovenUmisteniObjektuDI"]),
                        "precisionPosition": position, "precisionHeight": int(attributes["TridaPresnostiVyska"]),
                        "acquisitionMethod": acquisition, "incompleteData": partial == "true", "horizontalUsable": usable,
                        "heightStatus": {"positive": sum(z is not None for z in heights), "zero": sum(point[2] == 0 for point in curve["points"]),
                                         "nonpositive": sum(point[2] < 0 for point in curve["points"])},
                        "clipped": False, "attributes": attributes, "sourceGeometry": {"curve": curve},
                        "sourcePackage": path.name, "sourceMember": member, "sourceSnapshotDate": snapshot_date,
                        "sourceOperation": action, "sourceUpdateDate": manifest.get("sourceDate", snapshot_date),
                    }
                    state[object_id] = (feature, shape)
                    applied["retainedChange" if mode == "daily-change" else "retainedSnapshot"] += 1
            if header.get("VerzeJVFDTM") != "1.4.3" or header.get("TypZapisu") != ("kompletní zápis" if mode == "snapshot" else "změnové věty"):
                raise ValueError("Unsupported JVF DI version or operation mode")
            sources.append({"file": path.name, "member": member, "sha256": digest, "bytes": len(package_bytes),
                            "url": manifest.get("url"), "header": header, "kind": mode,
                            "sourceDate": manifest.get("sourceDate", snapshot_date)})
        if archive:
            archive.close()
    features, diagnostics, excluded, shapes = [], [], [], []
    for object_id in sorted(state):
        feature, shape = state[object_id]
        if feature["horizontalUsable"]:
            features.append(feature)
            shapes.append(shape)
        elif feature["dtmClass"] == "0100000026":
            diagnostics.append(feature)
        else:
            excluded.append(feature)
    if not features:
        raise ValueError("No usable terrestrial-geodetic individual track axis intersects the corridor")
    tree = STRtree(shapes)
    distances = []
    for first, second in zip(route["points"], route["points"][1:]):
        start, end = first["distance"], second["distance"]
        for station in range(math.ceil(start / 10) * 10, math.ceil(end / 10) * 10, 10):
            t = (station - start) / (end - start or 1)
            lon = first["lon"] + (second["lon"] - first["lon"]) * t
            lat = first["lat"] + (second["lat"] - first["lat"]) * t
            point = Point(to_native.transform(lon, lat))
            distances.append({"s": station, "distance": shapes[int(tree.nearest(point))].distance(point)})
    return {
        "attribution": f"Digitální technická mapa Prahy / veřejné DI přes IS DMVS (ČÚZK), {snapshot_date[:4]}; source owner/editor IDs retained",
        "license": None, "licenseUrl": None, "rulesUrl": PUBLIC_DI_RULES,
        "licenseStatus": "No explicit DI-specific redistribution licence identified in the source packages or official public distribution page; public access is not relabelled as CC BY",
        "access": "Anonymous public DI snapshots and daily changes provided without login under official DMVS public distribution rules",
        "sourceOwners": dict(sorted(Counter(f["attributes"].get("IDVlastnika", "unspecified") for f in features).items())),
        "sourceEditors": dict(sorted(Counter(f["attributes"].get("IDEditora", "unspecified") for f in features).items())),
        "schemaUrl": dtm.SCHEMA_URL, "sourceName": "Public JVF DTM 1.4.3 DI individual tram-track axes",
        "sourceSnapshotDate": snapshot_date, "latestDailyUpdateDate": max(dates) if dates else None,
        "requestedAsOfDate": requested_as_of or snapshot_date,
        "sourceSpatialReference": {"wkid": 5514}, "outputSpatialReference": "EPSG:4326; [latitude, longitude]",
        "geometrySimplificationMeters": 0, "sources": sources, "classInventory": dict(sorted(inventory.items())),
        "features": features, "diagnosticAxes": diagnostics, "excludedAxes": excluded,
        "processing": {"corridorMeters": corridor_meters, "clipping": False, "coordinateTransformAccuracyMeters": transform["accuracyMeters"],
                       "transformMetadata": transform, "sourceOperations": dict(operations), "appliedOperations": dict(applied),
                       "horizontalFilter": {"dtmClass": "0100000027", "precisionPosition": 3, "acquisitionMethod": 1}},
        "counts": {"features": len(features), "objects": len(features), "vertices": sum(len(f["points"]) for f in features),
                   "diagnosticAxes": len(diagnostics), "excludedAxes": len(excluded),
                   "byLevel": dict(sorted(Counter(f["level"] for f in features).items()))},
        "quality": {"incompleteDataObjects": sum(f["incompleteData"] for f in features),
                    "heightStatus": dict(sum((Counter(f["heightStatus"]) for f in features), Counter())),
                    "objectsWithAllPositiveZ": sum(all(z is not None for z in f["elevations"]) for f in features),
                    "objectsWithAllMissingZ": sum(all(z is None for z in f["elevations"]) for f in features)},
        "coverage": {"alignment": "Supplied GTFS plan, not directed OSM track; nearest-axis distance is diagnostic, not source coverage proof",
                     "routeSampleSpacingMeters": 10, "routeSamples": len(distances), "nearestAxisSamples": distances},
        "changes": "Complete source lines selected by corridor intersection; only XY transformed; no rounding, simplification or clipping. Native XYZ, original coordinate text, all leaf attributes, source IDs and operations retained in the linked lossless archive. Nonpositive source Z maps to null runtime elevations.",
        "limitations": ["Horizontal refinement candidate only; elevations are retained but not adopted as rail height.",
                        "Source publication date is not the survey date of each object.",
                        "Native source precision is distinct from the declared 1 m WGS84 transformation accuracy.",
                        "NeuplnaData is preserved and does not guarantee all source attributes or elevations are complete.",
                        "Whole-tramway derived axes are diagnostics only, not individual track geometry.",
                        "Source endpoint connectivity and direction are not explicit; matching must preserve OSM graph, switches and official chainage.",
                        "DI levels are relative source ordering, not globally interchangeable with OSM layers."],
    }


def write_candidates(result, output, source_archive):
    raw = (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    with Path(source_archive).open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, compresslevel=9, mtime=0) as compressed:
            compressed.write(raw)
    archive_bytes = Path(source_archive).read_bytes()
    runtime = {**result}
    for key in ["features", "diagnosticAxes", "excludedAxes"]:
        runtime[key] = [{**{name: value for name, value in feature.items() if name != "sourceGeometry"},
                         "sourceRecordId": feature["id"]} for feature in result[key]]
    runtime["sourceArchive"] = {"file": Path(source_archive).name, "sha256": hashlib.sha256(archive_bytes).hexdigest(),
                                "uncompressedSha256": hashlib.sha256(raw).hexdigest(), "bytes": len(archive_bytes),
                                "uncompressedBytes": len(raw), "format": "gzip JSON; sourceRecordId resolves to full native axis record"}
    Path(output).write_text(json.dumps(runtime, ensure_ascii=False, separators=(",", ":")) + "\n")
    return runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", default=[])
    parser.add_argument("--change-input", type=Path, action="append", default=[])
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--snapshot-date")
    parser.add_argument("--requested-as-of")
    parser.add_argument("--grid", type=Path, required=True)
    parser.add_argument("--route", type=Path, default=Path(__file__).resolve().parents[1] / "public/data/route22.json")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path)
    args = parser.parse_args()
    metadata = {}
    if args.manifest:
        if not args.cache_dir or args.input or args.change_input:
            parser.error("Manifest requires cache-dir and no explicit input files")
        manifest = json.loads(args.manifest.read_text())
        if manifest["content"] != "Di":
            parser.error("Track importer requires DI source content")
        args.snapshot_date = args.snapshot_date or manifest["snapshotDate"]
        args.requested_as_of = args.requested_as_of or manifest["requestedAsOfDate"]
        for package in manifest["packages"]:
            metadata[package["file"]] = package
            (args.input if package["kind"] == "snapshot" else args.change_input).append(args.cache_dir / package["file"])
    if not args.input or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.snapshot_date or ""):
        parser.error("Supply source snapshots/date or a manifest")
    if args.output.resolve() == (Path(__file__).resolve().parents[1] / "public/data/dtm-track-axes.json").resolve():
        parser.error("Prepare a candidate before explicitly adopting live axes")
    result = import_axes(args.input, json.loads(args.route.read_text()), args.snapshot_date,
                         changes=args.change_input, package_metadata=metadata, grid_path=args.grid,
                         requested_as_of=args.requested_as_of)
    archive = args.source_archive or args.output.with_suffix(".source.json.gz")
    runtime = write_candidates(result, args.output, archive)
    print(json.dumps({"output": str(args.output), "sourceArchive": str(archive), "counts": result["counts"],
                      "quality": result["quality"], "runtimeBytes": args.output.stat().st_size,
                      "sourceArchiveBytes": runtime["sourceArchive"]["bytes"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
