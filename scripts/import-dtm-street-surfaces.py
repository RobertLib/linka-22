#!/usr/bin/env python3
"""Prepare a reviewable street-surface candidate from public JVF DTM 1.4.3.

Requires pyproj and Shapely 2. Import only genuine derived polygons (suffix
03); definition points never create guessed road or sidewalk footprints.
Select complete source polygons intersecting the route corridor. Original
vertices, holes, 3D boundaries and levels remain in lossless provenance.
Invalid plan rings are normalized with verified even/odd equivalence.

Example:
  PYTHONPATH=/private/tmp/linka-geotools python3 scripts/import-dtm-street-surfaces.py \
    --input /private/tmp/linka-dmvs-praha1-opl.jvf.zip \
    --snapshot-date 2026-09-30 --output /private/tmp/linka-dtm-candidate.json

The output must be audited before replacing the scene's existing dataset.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import gzip
import json
import math
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

try:
    from pyproj import Transformer, datadir, proj_version_str
    from pyproj.transformer import TransformerGroup, AreaOfInterest
    from shapely import make_valid
    from shapely.geometry import LineString, Point, Polygon
    from shapely.ops import polygonize, unary_union
    from shapely.strtree import STRtree
    from shapely.validation import explain_validity
except ImportError:
    raise SystemExit("Install pyproj and Shapely 2 before importing JVF DTM")

SCHEMA_URL = "https://www.cuzk.gov.cz/DMVS/JVF-DTM/xsd-1_4_3_navrh.aspx"
RULES_URL = "https://geoportalpraha.cz/backend/getdokument/1"
CUZK_RULES_URL = "https://cuzk.gov.cz/Predpisy/Podminky-poskytovani-prostor-dat-a-sitovych-sluzeb/Podminky-poskytovani-prostorovych-dat-CUZK.aspx"
VERTICAL_RULES_URL = "https://www.cuzk.gov.cz/getattachment/DMVS/Metodika/Metodika_porizovani_dat_DTM_final_signed.pdf.aspx?lang=cs-CZ"

# Proven by the official JVF 1.4.3 object XSDs' fixed code_base/code_suffix.
# Scene code remains compatible with the former IPR category codes; dtmClass
# preserves the authoritative JVF classification, including platform subtype.
CLASSES = {
    "0100000005": ("road", 701, "provozni_plocha_pozemni_komunikace-plocha.xsd"),
    "0100000007": ("sidewalk", 702, "chodnik-plocha.xsd"),
    "0100000009": ("cycleway", 703, "cyklostezka-plocha.xsd"),
    "0100000011": ("parking", 704, "parkoviste_odstavna_plocha-plocha.xsd"),
    "0100000024": ("tram", 705, "tramvajova_draha-plocha.xsd"),
    "0100000053": ("sidewalk", 702, "nastupiste-plocha.xsd"),
    "0100000320": ("paved", 700, "pridruzena_plocha_pozemni_komunikace-plocha.xsd"),
    "0100000058": ("bridge_structure", None, "plocha_mostni_konstrukce-plocha.xsd"),
    "0100000215": ("green", 700, "udrzovana_plocha_zelene-plocha.xsd"),
    "0100000312": ("railway_structure", None, "souhrnna_plocha_zeleznicnich_drah-plocha.xsd"),
}
SURFACES = {"1": "asphalt", "2": "concrete", "3": "paving_stones", "5": "sand", "6": "gravel", "7": "unpaved"}


def local_name(element):
    return element.tag.rsplit("}", 1)[-1]


def descendant(element, name):
    return next((child for child in element.iter() if local_name(child) == name), None)


def leaf_attributes(element):
    result = {}
    if element is not None:
        for child in element.iter():
            if len(child) == 0:
                name, value = local_name(child), (child.text or "").strip()
                if name in result and result[name] != value:
                    raise ValueError(f"Conflicting attribute {name}")
                result[name] = value
    return result


def epsg_name(value):
    match = re.search(r"(?:EPSG(?::|::)|EPSG/\d+/)(\d+)$", value or "", re.I)
    if not match or match.group(1) != "5514":
        raise ValueError(f"Unsupported source CRS {value!r}; expected declared EPSG:5514")
    return "EPSG:5514"


def linear_positions(element, dimension):
    # Derived ZPS boundaries use straight segments. Refuse unsupported curves
    # rather than linearize away a recorded circular or spline boundary.
    forbidden = {"Arc", "ArcString", "Circle", "ArcByCenterPoint", "BSpline", "Bezier"}
    if any(local_name(child) in forbidden for child in element.iter()):
        raise ValueError("Nonlinear GML boundary requires a lossless importer")
    lists = [child for child in element.iter() if local_name(child) == "posList"]
    if len(lists) != 1:
        raise ValueError("Expected exactly one linear GML posList")
    node = lists[0]
    dimension = int(node.get("srsDimension", dimension))
    if dimension not in (2, 3):
        raise ValueError(f"Unsupported coordinate dimension {dimension}")
    text = (node.text or "").strip()
    tokens = text.split()
    if len(tokens) % dimension:
        raise ValueError("Incomplete GML coordinate tuple")
    points = [[float(value) for value in tokens[i:i + dimension]] for i in range(0, len(tokens), dimension)]
    if not all(math.isfinite(value) for point in points for value in point):
        raise ValueError("Nonfinite source coordinate")
    return points, text


def polygon_geometry(record):
    property_node = descendant(record, "surfaceProperty")
    if property_node is None:
        raise ValueError("A derived street class has no surfaceProperty; centroid geometry is not a footprint")
    polygons = [element for element in property_node.iter() if local_name(element) == "Polygon"]
    if not polygons:
        raise ValueError("Unsupported GML surface encoding; expected Polygon")
    result = []
    for polygon in polygons:
        crs = epsg_name(polygon.get("srsName"))
        dimension = int(polygon.get("srsDimension", "2"))
        rings, texts = [], []
        for name in ("exterior", "interior"):
            for boundary in polygon:
                if local_name(boundary) != name:
                    continue
                points, text = linear_positions(boundary, dimension)
                if len(points) < 4 or points[0][:2] != points[-1][:2]:
                    raise ValueError("Source polygon ring is not closed")
                rings.append(points)
                texts.append(text)
        if not rings:
            raise ValueError("Source polygon has no exterior")
        result.append({"crs": crs, "rings": rings, "positionText": texts})
    return result


def boundary_geometry(record):
    property_node = descendant(record, "multiCurveProperty")
    if property_node is None:
        return []
    collection = descendant(property_node, "MultiCurve")
    if collection is None:
        raise ValueError("Unsupported boundary encoding; expected MultiCurve")
    inherited_crs = collection.get("srsName")
    inherited_dimension = int(collection.get("srsDimension", "3"))
    result = []
    for line in collection.iter():
        if local_name(line) != "LineString":
            continue
        crs = epsg_name(line.get("srsName", inherited_crs))
        points, text = linear_positions(line, int(line.get("srsDimension", inherited_dimension)))
        if any(len(point) != 3 for point in points):
            raise ValueError("3D source boundary lacks a Z coordinate")
        result.append({"crs": crs, "points": points, "positionText": text})
    if not result:
        raise ValueError("Unsupported 3D boundary; no LineString was found")
    return result


def vertex_heights(rings, curves):
    heights = defaultdict(set)
    for curve in curves:
        for x, y, z in curve["points"]:
            heights[x, y].add(z)
    # Retain ambiguity instead of choosing a high or low vertical edge.
    result, interpolations = [], []
    status = Counter()
    for ring_index, ring in enumerate(rings):
        values = []
        for vertex_index, point in enumerate(ring):
            available = {point[2]} if len(point) == 3 else heights.get(tuple(point[:2]), set())
            segments = []
            if not available:
                computed = []
                for curve_index, curve in enumerate(curves):
                    for segment_index, (a, b) in enumerate(zip(curve["points"], curve["points"][1:])):
                        dx, dy = b[0] - a[0], b[1] - a[1]
                        length2 = dx * dx + dy * dy
                        if length2 <= 1e-16:
                            continue
                        t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2
                        if t < -1e-9 or t > 1 + 1e-9:
                            continue
                        t = max(0, min(1, t))
                        if math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy) > 1e-7:
                            continue
                        computed.append(a[2] + (b[2] - a[2]) * t)
                        segments.append({"curve": curve_index, "segment": segment_index, "parameter": t})
                if computed:
                    available = {computed[0]} if max(computed) - min(computed) < 1e-7 else set(computed)
            value = next(iter(available)) if len(available) == 1 else None
            status["matched" if value is not None else "ambiguous" if available else "missing"] += 1
            if value == 0:
                status["zero"] += 1
            if segments:
                status["interpolated" if value is not None else "ambiguousIntersection"] += 1
                interpolations.append({"ring": ring_index, "vertex": vertex_index,
                                       "method": "source-boundary-segment" if value is not None else "ambiguous-intersection",
                                       "sourceSegments": segments, "elevation": value})
            values.append(value)
        result.append(values)
    return result, dict(status), interpolations


def polygon_parts(geometry):
    if geometry.geom_type == "Polygon":
        yield geometry
    elif hasattr(geometry, "geoms"):
        for part in geometry.geoms:
            yield from polygon_parts(part)


def even_odd_plan(rings):
    linework = unary_union([LineString([point[:2] for point in ring]) for ring in rings])
    def contains(point, ring):
        inside = False
        for a, b in zip(ring, ring[1:]):
            if (a[1] > point.y) != (b[1] > point.y) and point.x < a[0] + (point.y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]):
                inside = not inside
        return inside
    faces = [face for face in polygonize(linework)
             if sum(contains(face.representative_point(), ring) for ring in rings) % 2]
    return unary_union(faces), linework


def normalize_feature(feature, shape, transformer):
    if shape.is_valid:
        return [(feature, shape)], None
    raw = feature["sourceGeometry"]
    rings = raw["surface"]["rings"]
    expected, original_linework = even_odd_plan(rings)
    normalized = make_valid(shape)
    pieces = list(polygon_parts(normalized))
    normalized_union = unary_union(pieces)
    difference = expected.symmetric_difference(normalized_union).area
    if difference > max(1e-7, expected.area * 1e-9):
        raise ValueError(f"Normalization changed the even/odd source footprint: {feature['id']} ({difference} square metres)")
    results = []
    for index, piece in enumerate(pieces):
        native_rings = [list(map(list, piece.exterior.coords))] + [list(map(list, ring.coords)) for ring in piece.interiors]
        heights, status, interpolations = vertex_heights(native_rings, raw["boundary3D"])
        projected = [[[lat, lon] for lon, lat in [transformer.transform(*point[:2]) for point in ring]] for ring in native_rings]
        result = {**feature, "id": feature["id"] if index == 0 else feature["id"] + f"/normalized/{index}",
                  "points": projected[0], "holes": projected[1:], "elevations": heights[0], "holeElevations": heights[1:],
                  "heightStatus": status, "elevationInterpolations": interpolations,
                  "clipHoleEdges": [[] for _ in projected[1:]], "sourceNormalized": True,
                  "originalSourceRecordId": feature["id"], "normalizationPart": index,
                  "rawNativeGeometry": raw,
                  "sourceGeometry": {"surface": {"crs": "EPSG:5514", "rings": native_rings, "positionText": []}, "boundary3D": raw["boundary3D"]}}
        results.append((result, piece))
    discarded_lines = original_linework.difference(normalized_union.boundary)
    report = {"id": feature["id"], "objectId": feature["objectId"], "reason": explain_validity(shape),
              "polygonParts": len(pieces), "evenOddAreaSquareMeters": expected.area,
              "normalizedAreaSquareMeters": normalized_union.area, "symmetricDifferenceAreaSquareMeters": difference,
              "droppedZeroAreaLineLengthMeters": discarded_lines.length,
              "droppedZeroAreaLineworkWKT": discarded_lines.wkt,
              "interpolatedVertices": sum(part[0]["heightStatus"].get("interpolated", 0) for part in results)}
    return results, report


def iter_records(stream, header, inventory):
    stack, groups = [], {}
    for event, element in ET.iterparse(stream, events=("start", "end")):
        name = local_name(element)
        if event == "start":
            stack.append(element)
            continue
        if name == "ObjektovyTypNazev":
            groups[id(stack[-2])] = {
                "base": element.get("code_base"), "suffix": element.get("code_suffix"),
                "name": (element.text or "").strip(),
            }
        if len(stack) <= 3 and name in {"VerzeJVFDTM", "DatumZapisu", "TypZapisu"}:
            header[name] = (element.text or "").strip()
        if name == "ZaznamObjektu":
            group = groups.get(id(stack[-3]))
            if group is None:
                raise ValueError("JVF record lacks its parent class declaration")
            inventory[group["base"] + "/" + group["suffix"]] += 1
            if group["base"] in CLASSES and group["suffix"] == "03":
                yield group, element
            stack[-2].remove(element)
        if id(element) in groups:
            groups.pop(id(element))
        stack.pop()


def coordinate_transform(route, grid_path=None):
    if grid_path and tuple(int(part) for part in proj_version_str.split(".")[:2]) < (9, 4):
        raise ValueError("The official Czech projected correction grid requires PROJ >= 9.4; use Python >= 3.11 with pyproj 3.8+ wheels")
    lons = [point["lon"] for point in route["points"]]
    lats = [point["lat"] for point in route["points"]]
    area = AreaOfInterest(min(lons) - 0.1, min(lats) - 0.1, max(lons) + 0.1, max(lats) + 0.1)
    group = TransformerGroup("EPSG:5516" if grid_path else "EPSG:5514", "EPSG:4326", always_xy=True, area_of_interest=area)
    options = [candidate for candidate in group.transformers if candidate.accuracy >= 0]
    if not group.best_available or not options:
        raise ValueError("Best coordinate transform unavailable; prepare its declared grids first")
    chosen = min(options, key=lambda candidate: candidate.accuracy)
    metadata = {"description": chosen.description, "accuracyMeters": chosen.accuracy,
                "bestAvailable": group.best_available, "projVersion": proj_version_str, "grid": None}
    if grid_path:
        grid_path = Path(grid_path).resolve()
        datadir.append_data_dir(str(grid_path.parent))
        # This authoritative GTG declares its projected source/target CRS.
        # PROJ >=9.4 applies that CRS translation, including the modified
        # Krovak offset; do not add the 5,000 km offset a second time.
        pipeline = '+proj=pipeline +step +proj=gridshift +grids="' + str(grid_path) + '" ' + chosen.to_proj4().removeprefix("+proj=pipeline")
        chosen = Transformer.from_pipeline(pipeline)
        metadata["description"] = "ČÚZK table_-y-x_3_v1710 projected grid, then " + metadata["description"]
        metadata["grid"] = {"file": grid_path.name, "sha256": hashlib.sha256(grid_path.read_bytes()).hexdigest(),
                            "url": "https://cdn.proj.org/cz_cuzk_table_-y-x_3_v1710.tif",
                            "sourceCRS": "EPSG:5514", "targetCRS": "EPSG:5516"}
    class Inverse:
        def transform(self, *point):
            return chosen.transform(*point, direction="INVERSE")
    # A round trip also checks the grid covers this route and catches a
    # mistaken modified-Krovak false-origin convention before any import.
    native = Inverse()
    for point in (route["points"][0], route["points"][-1]):
        xy = native.transform(point["lon"], point["lat"])
        lon, lat = chosen.transform(*xy)
        if not all(math.isfinite(value) for value in (*xy, lon, lat)) or abs(lon - point["lon"]) + abs(lat - point["lat"]) > 1e-7:
            raise ValueError("Coordinate transform failed its route round-trip check")
    return native, chosen, metadata


def import_sources(inputs, route, snapshot_date, corridor_meters=100, source_urls=None,
                   changes=None, package_metadata=None, grid_path=None, requested_as_of=None,
                   track_envelope=None):
    to_native, to_wgs84, transform_metadata = coordinate_transform(route, grid_path)
    corridor = LineString([to_native.transform(point["lon"], point["lat"]) for point in route["points"]]).buffer(corridor_meters)
    rail_envelope, envelope_metadata = None, None
    if track_envelope:
        geometry, properties = track_envelope["geometry"], track_envelope["properties"]
        if geometry["type"] != "MultiLineString":
            raise ValueError("Track selection envelope must contain actual rail MultiLineString coordinates")
        radius = float(properties["selectionRadiusMeters"])
        if not 0 < radius <= 2:
            raise ValueError("Vegetation selection must stay within the physical rail envelope")
        rail_envelope = unary_union([LineString([to_native.transform(*point) for point in line])
                                    for line in geometry["coordinates"]]).buffer(radius)
        envelope_metadata = {"properties": properties, "geometrySha256": hashlib.sha256(
            json.dumps(geometry, separators=(",", ":")).encode()).hexdigest(),
            "selection": "Complete maintained-vegetation polygons intersecting actual rail alignment buffered by selectionRadiusMeters; no footprint clipping"}
    state, source_files = {}, []
    inventory, ids, invalid, date_values = Counter(), {}, [], []
    operation_counts, applied_counts = Counter(), Counter()
    package_metadata = package_metadata or {}
    packages = [(Path(path), "snapshot") for path in inputs] + [(Path(path), "daily-change") for path in (changes or [])]
    dates = [package_metadata.get(path.name, {}).get("sourceDate", path.name) for path, mode in packages if mode == "daily-change"]
    if dates != sorted(dates):
        raise ValueError("Daily changes must be applied chronologically")
    for path, mode in packages:
        package_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        source_metadata = package_metadata.get(path.name, {})
        if source_metadata.get("sha256", package_sha) != package_sha:
            raise ValueError(f"Package checksum differs from catalogue manifest: {path.name}")
        archive = zipfile.ZipFile(path) if zipfile.is_zipfile(path) else None
        members = [name for name in archive.namelist() if name.lower().endswith(".xml")] if archive else [path.name]
        if not members:
            raise ValueError(f"No XML member in {path}")
        for member in members:
            header = {}
            stream = archive.open(member) if archive else path.open("rb")
            with stream:
                for group, record in iter_records(stream, header, inventory):
                    attributes = leaf_attributes(descendant(record, "AtributyObjektu"))
                    object_id = attributes.get("ID")
                    if not object_id:
                        raise ValueError("Derived polygon lacks source ID")
                    action_node = descendant(record, "ZapisObjektu")
                    action = (action_node.text or "").strip() if action_node is not None else ""
                    if action not in {"i", "u", "d", "r"}:
                        raise ValueError(f"Unknown source operation {action!r}")
                    operation_counts[mode + "/" + action] += 1
                    if mode == "daily-change" and action == "d":
                        if state.pop(object_id, None) is not None:
                            applied_counts["deleted"] += 1
                        ids = {key: value for key, value in ids.items() if not key.startswith(f"dtm/{object_id}/")}
                        continue
                    if mode == "daily-change" and action == "r" and object_id in state:
                        applied_counts["existingReferenceKept"] += 1
                        continue
                    if mode == "daily-change" and action in {"i", "u"}:
                        had_previous = state.pop(object_id, None) is not None
                        ids = {key: value for key, value in ids.items() if not key.startswith(f"dtm/{object_id}/")}
                        applied_counts["replaced" if had_previous else "insertOrUpdateAbsent"] += 1
                    curves = boundary_geometry(record)
                    kind, code, xsd = CLASSES[group["base"]]
                    pending = []
                    for part, polygon in enumerate(polygon_geometry(record)):
                        rings = polygon["rings"]
                        shape = Polygon([p[:2] for p in rings[0]], [[p[:2] for p in ring] for ring in rings[1:]])
                        selection = rail_envelope if kind == "green" else corridor
                        if selection is None or not shape.intersects(selection):
                            continue
                        identity = f"dtm/{object_id}/{part}"
                        fingerprint = hashlib.sha256(json.dumps({"rings": rings, "curves": [curve["points"] for curve in curves], "attributes": attributes}, sort_keys=True).encode()).hexdigest()
                        if identity in ids:
                            if ids[identity] != fingerprint:
                                raise ValueError(f"Conflicting duplicate source object {identity}; do not mix snapshots")
                            continue
                        ids[identity] = fingerprint
                        if not shape.is_valid:
                            invalid.append({"id": identity, "reason": explain_validity(shape)})
                        heights, height_status, interpolations = vertex_heights(rings, curves)
                        def project_ring(ring):
                            return [[lat, lon] for lon, lat in [to_wgs84.transform(*p[:2]) for p in ring]]
                        feature = {
                            "id": identity, "objectId": object_id, "kind": kind, "code": code,
                            "dtmClass": group["base"], "dtmSuffix": group["suffix"], "dtmName": group["name"],
                            "dtmSchema": xsd, "level": int(attributes["UrovenUmisteniObjektuZPS"]),
                            "points": project_ring(rings[0]), "holes": [project_ring(ring) for ring in rings[1:]],
                            "elevations": heights[0], "holeElevations": heights[1:],
                            "surface": SURFACES.get(attributes.get("PrevazujiciPovrch")),
                            "clipped": False, "clipEdges": [], "clipHoleEdges": [[] for _ in rings[1:]],
                            "precision": {"positionClass": attributes.get("TridaPresnostiPoloha"), "heightClass": attributes.get("TridaPresnostiVyska")},
                            "precisionPosition": int(attributes["TridaPresnostiPoloha"]),
                            "precisionHeight": int(attributes["TridaPresnostiVyska"]),
                            "heightStatus": height_status,
                            "elevationInterpolations": interpolations,
                            "attributes": attributes,
                            "sourceGeometry": {"surface": polygon, "boundary3D": curves},
                            "sourcePackage": path.name, "sourceMember": member, "sourceSnapshotDate": snapshot_date,
                            "sourceOperation": action, "sourceUpdateDate": source_metadata.get("sourceDate", snapshot_date),
                        }
                        if group["base"] == "0100000053":
                            feature["subtype"] = "platform"
                        if kind == "green":
                            feature["surface"] = "grass"
                        pending.append((feature, shape))
                    if pending:
                        state[object_id] = pending
                        applied_counts["retained" + ("Change" if mode == "daily-change" else "Snapshot")] += 1
            expected_type = "kompletní zápis" if mode == "snapshot" else "změnové věty"
            if header.get("VerzeJVFDTM") != "1.4.3" or header.get("TypZapisu") != expected_type:
                raise ValueError(f"Unsupported JVF version or unexpected package operation: {header}")
            source_files.append({"file": path.name, "member": member, "sha256": package_sha, "bytes": path.stat().st_size,
                                 "url": source_metadata.get("url") or (source_urls or {}).get(str(path)), "header": header,
                                 "kind": mode, "sourceDate": source_metadata.get("sourceDate", snapshot_date)})
        if archive:
            archive.close()
    features, structures, railway_structures, shapes, repairs = [], [], [], [], []
    for object_id in sorted(state):
        for feature, shape in state[object_id]:
            normalized, repair = normalize_feature(feature, shape, to_wgs84)
            if repair:
                repairs.append(repair)
            for feature, shape in normalized:
                if feature["kind"] == "bridge_structure":
                    structures.append(feature)
                elif feature["kind"] == "railway_structure":
                    railway_structures.append(feature)
                else:
                    features.append(feature)
                    shapes.append(shape)
                date_values.extend(value for name, value in feature["attributes"].items() if name in {"DatumVkladu", "DatumZmeny"} and value and not value.startswith("0001-"))
    surviving_ids = {feature["id"] for feature in features + structures + railway_structures}
    invalid = [record for record in invalid if record["id"] in surviving_ids]
    if not features:
        raise ValueError("No derived street polygon intersects this corridor; no guessed point-derived surface was produced")
    associations = []
    records = {feature["id"]: (feature, shape) for feature, shape in zip(features, shapes)}
    for association in (track_envelope or {}).get("properties", {}).get("levelAssociations", []):
        feature, shape = records.get(association["sourceRecordId"], (None, None))
        evidence = association["evidencePoint"]
        stations = association["stationRange"]
        if (not feature or feature["dtmClass"] != "0100000024" or feature["level"] != association["sourceLevel"]
            or not re.fullmatch(r"way/\d+", association["osmId"])
            or not 0 <= stations["from"] <= stations["to"] <= route["points"][-1]["distance"]
            or not shape.covers(Point(to_native.transform(evidence["lon"], evidence["lat"])))):
            raise ValueError("Track level association lacks matching tram source geometry, native level or evidence containment")
        associations.append(association)
    tree = STRtree(shapes)
    missing, sample_counts, samples = [], Counter(), 0
    points = route["points"]
    for first, second in zip(points, points[1:]):
        start, end = first["distance"], second["distance"]
        for station in range(math.ceil(start / 10) * 10, math.ceil(end / 10) * 10, 10):
            t = (station - start) / (end - start or 1)
            lon = first["lon"] + (second["lon"] - first["lon"]) * t
            lat = first["lat"] + (second["lat"] - first["lat"]) * t
            point = Point(to_native.transform(lon, lat))
            found = [features[index] for index in tree.query(point, predicate="intersects")]
            kinds = {feature["kind"] for feature in found if feature["level"] == 0}
            sample_counts.update(kinds)
            samples += 1
            if not kinds.intersection({"road", "tram", "paved"}):
                missing.append(station)
    intervals = []
    for station in missing:
        if intervals and station - intervals[-1]["to"] == 10:
            intervals[-1]["to"] = station
        else:
            intervals.append({"from": station, "to": station})
    return {
        "attribution": f"datový podklad © IPR Praha; ČÚZK, {snapshot_date[:4]}; source editor IDs retained",
        "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "rulesUrl": RULES_URL, "additionalRulesUrl": CUZK_RULES_URL, "schemaUrl": SCHEMA_URL,
        "sourceName": "Public JVF DTM 1.4.3 derived ZPS street polygons",
        "sourceSnapshotDate": snapshot_date, "sourceSpatialReference": {"wkid": 5514},
        "requestedAsOfDate": requested_as_of or snapshot_date,
        "latestDailyUpdateDate": max(dates) if dates else None,
        "verticalReference": {"name": "Source boundary heights; Bpv convention in DTM acquisition methodology", "source": VERTICAL_RULES_URL, "conversion": "none"},
        "outputSpatialReference": "EPSG:4326; coordinates ordered [latitude, longitude]; native geometry retained",
        "geometrySimplificationMeters": 0,
        "changes": "Selected genuine derived polygon classes intersecting corridor; transformed only plan XY to WGS84; original native source rings, holes, position strings, 3D boundary curves, levels, precision classes and timestamps retained. Invalid plan rings normalized with make_valid, independently verified against original even/odd source boundary faces; zero-area retraced lines retained in raw provenance. No clipping, rounding or simplification.",
        "processing": {"corridorMeters": corridor_meters, "sourceGeometryRepair": bool(repairs),
                       "repairedObjectIds": [repair["objectId"] for repair in repairs], "normalization": repairs,
                       "coordinateTransform": transform_metadata["description"], "coordinateTransformAccuracyMeters": transform_metadata["accuracyMeters"],
                       "transformMetadata": transform_metadata, "sourceOperations": dict(operation_counts), "appliedOperations": dict(applied_counts)},
        "trackEnvelopeSelection": envelope_metadata, "trackLevelAssociations": associations,
        "sources": source_files,
        "classInventory": dict(sorted(inventory.items())),
        "features": features, "bridgeStructures": structures, "railwayStructures": railway_structures,
        "counts": {"features": len(features), "objects": len({f["objectId"] for f in features}),
                   "vertices": sum(len(f["points"]) + sum(map(len, f["holes"])) for f in features),
                   "holes": sum(len(f["holes"]) for f in features), "artificialClipEdges": 0,
                   "byKind": dict(sorted(Counter(f["kind"] for f in features).items())),
                   "byLevel": dict(sorted(Counter(f["level"] for f in features).items())), "bridgeStructures": len(structures),
                   "railwayStructures": len(railway_structures)},
        "quality": {"invalidSourcePolygons": invalid, "invalidRuntimePolygons": [],
                    "normalizedSourcePolygons": len(repairs), "completeSourcePolygons": True},
        "coverage": {"corridorMeters": corridor_meters, "routeSampleSpacingMeters": 10, "routeSamples": samples,
                     "alignment": "Supplied route JSON plan centreline; ground-level polygons only, not assumed current rail alignment",
                     "routeSamplesWithRoadTramOrPaved": samples - len(missing), "routeSamplesByKind": dict(sample_counts),
                     "routeCoveragePercent": round(100 * (samples - len(missing)) / samples, 3) if samples else 0,
                     "missingRoadTramIntervals": intervals},
        "sourceObjectDates": {"earliest": min(date_values) if date_values else None, "latest": max(date_values) if date_values else None},
        "limitations": [
            "Snapshot date is the source package's database state, not a claim that every object was surveyed on that date.",
            "Position/height precision classes are preserved; stored coordinate digits do not imply centimetre accuracy.",
            "Level is relative vertical ordering, not an automatically inferred bridge or tunnel type.",
            "Zero, missing or ambiguous boundary heights and precision class 9 must not be treated as trustworthy measured surface elevations.",
            "Object classes describe physical use; legal traffic access and lane directions require separate source metadata.",
            "Original invalid source plans remain in raw provenance; runtime polygons are normalized by documented even/odd-equivalent reconstruction, with any inserted boundary heights explicitly marked.",
            "Only supplied packages are covered. Full-line coverage and current rail alignment need independent audit.",
        ],
    }


def write_candidates(result, runtime_path, source_archive):
    raw = (json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    with Path(source_archive).open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, compresslevel=9, mtime=0) as compressed:
            compressed.write(raw)
    archive_bytes = Path(source_archive).read_bytes()
    runtime = {**result}
    def runtime_feature(feature):
        return {**{key: value for key, value in feature.items()
                   if key not in {"sourceGeometry", "rawNativeGeometry"}},
                "sourceRecordId": feature["id"]}
    runtime["features"] = [runtime_feature(feature) for feature in result["features"]]
    runtime["bridgeStructures"] = [runtime_feature(feature) for feature in result["bridgeStructures"]]
    runtime["railwayStructures"] = [runtime_feature(feature) for feature in result["railwayStructures"]]
    runtime["processing"] = {**result["processing"], "normalization": [
        {key: value for key, value in repair.items() if key != "droppedZeroAreaLineworkWKT"}
        for repair in result["processing"]["normalization"]
    ]}
    runtime["sourceArchive"] = {"file": Path(source_archive).name,
                                "sha256": hashlib.sha256(archive_bytes).hexdigest(),
                                "uncompressedSha256": hashlib.sha256(raw).hexdigest(),
                                "bytes": len(archive_bytes), "uncompressedBytes": len(raw),
                                "format": "gzip JSON; each runtime sourceRecordId resolves to an identically named full feature record"}
    Path(runtime_path).write_text(json.dumps(runtime, ensure_ascii=False, separators=(",", ":")) + "\n")
    return runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, action="append", default=[])
    parser.add_argument("--change-input", type=Path, action="append", default=[])
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--grid", type=Path)
    parser.add_argument("--track-envelope", type=Path)
    parser.add_argument("--route", type=Path, default=Path(__file__).resolve().parents[1] / "public/data/route22.json")
    parser.add_argument("--snapshot-date")
    parser.add_argument("--requested-as-of")
    parser.add_argument("--corridor-meters", type=float, default=100)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-archive", type=Path)
    args = parser.parse_args()
    package_metadata = {}
    if args.manifest:
        if args.input or args.change_input or not args.cache_dir:
            parser.error("Use --manifest with --cache-dir and without --input/--change-input")
        manifest = json.loads(args.manifest.read_text())
        args.snapshot_date = args.snapshot_date or manifest["snapshotDate"]
        args.requested_as_of = args.requested_as_of or manifest.get("requestedAsOfDate")
        for package in manifest["packages"]:
            package_metadata[package["file"]] = package
            target = args.input if package["kind"] == "snapshot" else args.change_input
            target.append(args.cache_dir / package["file"])
    if not args.input or not args.snapshot_date:
        parser.error("Supply snapshot inputs/date or a downloaded package manifest")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.snapshot_date):
        parser.error("snapshot date must be YYYY-MM-DD")
    if args.output.resolve() == (Path(__file__).resolve().parents[1] / "public/data/street-surfaces.json").resolve():
        parser.error("Write a candidate file first; this importer never overwrites the live scene dataset")
    result = import_sources(args.input, json.loads(args.route.read_text()), args.snapshot_date, args.corridor_meters,
                            changes=args.change_input, package_metadata=package_metadata,
                            grid_path=args.grid, requested_as_of=args.requested_as_of,
                            track_envelope=json.loads(args.track_envelope.read_text()) if args.track_envelope else None)
    archive_path = args.source_archive or args.output.with_suffix(".source.json.gz")
    runtime = write_candidates(result, args.output, archive_path)
    print(json.dumps({"output": str(args.output), "sourceArchive": str(archive_path), "counts": result["counts"],
                      "coverage": result["coverage"]["routeCoveragePercent"],
                      "normalizedSources": result["quality"]["normalizedSourcePolygons"],
                      "runtimeBytes": args.output.stat().st_size, "sourceArchiveBytes": runtime["sourceArchive"]["bytes"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
