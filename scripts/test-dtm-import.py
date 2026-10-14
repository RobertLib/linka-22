#!/usr/bin/env python3
"""Meaningful offline checks for the JVF source-preparation importer.

Run with the same pyproj/Shapely environment as import-dtm-street-surfaces.py.
"""
import importlib.util
from pathlib import Path
import tempfile
import gzip
import hashlib
import json
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("dtm_import", Path(__file__).with_name("import-dtm-street-surfaces.py"))
dtm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dtm)
GML = "http://www.opengis.net/gml/3.2"


def source_ring(dx=0):
    return [[-743010 + dx, -1043010], [-742990 + dx, -1043010],
            [-742990 + dx, -1042990], [-743010 + dx, -1042990], [-743010 + dx, -1043010]]


def xml_file(path, records, changes=False):
    root = ET.Element("JVFDTM")
    content = ET.SubElement(root, "DataJVFDTM")
    for name, value in [("VerzeJVFDTM", "1.4.3"), ("DatumZapisu", "2026-10-01T00:00:00"),
                        ("TypZapisu", "změnové věty" if changes else "kompletní zápis")]:
        ET.SubElement(content, name).text = value
    data = ET.SubElement(content, "Data")
    for record in records:
        group = ET.SubElement(data, "ObjectClass")
        ET.SubElement(group, "ObjektovyTypNazev", code_base=record.get("code", "0100000005"),
                      code_suffix=record.get("suffix", "03")).text = "source class"
        entries = ET.SubElement(group, "ZaznamyObjektu")
        entry = ET.SubElement(entries, "ZaznamObjektu")
        ET.SubElement(entry, "ZapisObjektu").text = record.get("action", "r")
        attributes = ET.SubElement(entry, "AtributyObjektu")
        for name, value in {"ID": record["id"], "UrovenUmisteniObjektuZPS": record.get("level", 0),
                            "TridaPresnostiPoloha": 3, "TridaPresnostiVyska": record.get("heightPrecision", 3),
                            "DatumVkladu": "2026-09-01T08:00:00", "PrevazujiciPovrch": "1"}.items():
            ET.SubElement(attributes, name).text = str(value)
        if record.get("action") == "d":
            continue
        geometry = ET.SubElement(entry, "GeometrieObjektu")
        if record.get("suffix") == "04":
            point = ET.SubElement(geometry, f"{{{GML}}}pointProperty")
            ET.SubElement(point, f"{{{GML}}}pos").text = "-743000 -1043000"
            continue
        surface = ET.SubElement(geometry, f"{{{GML}}}surfaceProperty")
        polygon = ET.SubElement(surface, f"{{{GML}}}Polygon", srsName="EPSG:5514", srsDimension="2")
        rings = [record.get("ring", source_ring())] + record.get("holes", [])
        for i, ring in enumerate(rings):
            boundary = ET.SubElement(polygon, f"{{{GML}}}" + ("exterior" if i == 0 else "interior"))
            linear = ET.SubElement(boundary, f"{{{GML}}}LinearRing")
            ET.SubElement(linear, f"{{{GML}}}posList").text = " ".join(str(value) for point in ring for value in point)
        property_node = ET.SubElement(geometry, f"{{{GML}}}multiCurveProperty")
        curves = ET.SubElement(property_node, f"{{{GML}}}MultiCurve", srsName="EPSG:5514", srsDimension="3")
        for ring in rings:
            member = ET.SubElement(curves, f"{{{GML}}}curveMember")
            line = ET.SubElement(member, f"{{{GML}}}LineString", srsName="urn:ogc:def:crs:EPSG::5514", srsDimension="3")
            vertices = [[*point, record.get("height", 200.123)] for point in ring]
            if record.get("ambiguous"):
                vertices.insert(1, [*ring[0], 201.123])
            ET.SubElement(line, f"{{{GML}}}posList").text = " ".join(str(value) for point in vertices for value in point)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)


class SourceImporterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        transformer = dtm.Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True)
        self.route = {"points": []}
        for distance, x in [(0, -743020), (100, -742970)]:
            lon, lat = transformer.transform(x, -1043000)
            self.route["points"].append({"lon": lon, "lat": lat, "distance": distance})

    def tearDown(self):
        self.temporary.cleanup()

    def make_file(self, name, records, changes=False):
        path = self.directory / name
        xml_file(path, records, changes)
        return path

    def test_exact_rings_holes_z_levels_and_boundary_duplicates(self):
        hole = [[-743005, -1043005], [-742995, -1043005], [-742995, -1042995],
                [-743005, -1042995], [-743005, -1043005]]
        source = self.make_file("snapshot.xml", [
            {"id": "road", "holes": [hole]},
            {"id": "platform", "code": "0100000053", "level": 1, "ambiguous": True},
        ])
        result = dtm.import_sources([source, source], self.route, "2026-09-30")
        self.assertEqual(result["counts"]["features"], 2)
        road = next(feature for feature in result["features"] if feature["objectId"] == "road")
        self.assertEqual(road["sourceGeometry"]["surface"]["rings"], [source_ring(), hole])
        self.assertEqual(road["elevations"], [200.123] * 5)
        self.assertEqual(road["holeElevations"], [[200.123] * 5])
        self.assertEqual(road["precisionHeight"], 3)
        self.assertEqual(road["attributes"]["DatumVkladu"], "2026-09-01T08:00:00")
        self.assertFalse(road["clipped"])
        self.assertEqual(result["geometrySimplificationMeters"], 0)
        platform = next(feature for feature in result["features"] if feature["objectId"] == "platform")
        self.assertEqual((platform["kind"], platform["code"], platform["dtmClass"], platform["level"]),
                         ("sidewalk", 702, "0100000053", 1))
        self.assertIsNone(platform["elevations"][0])
        self.assertEqual(len(platform["sourceGeometry"]["boundary3D"][0]["points"]), 6)

    def test_daily_update_delete_reference_and_move_outside_corridor(self):
        snapshot = self.make_file("snapshot.xml", [{"id": "road"}, {"id": "sidewalk", "code": "0100000007"}])
        change = self.make_file("change01.xml", [
            {"id": "road", "action": "u", "ring": source_ring(5), "height": 210},
            {"id": "sidewalk", "code": "0100000007", "action": "d"},
            {"id": "road", "action": "r", "height": 1},
            {"id": "platform", "code": "0100000053", "action": "i", "level": 1},
        ], changes=True)
        current = dtm.import_sources([snapshot], self.route, "2026-09-30", changes=[change])
        self.assertEqual({feature["objectId"] for feature in current["features"]}, {"road", "platform"})
        road = next(feature for feature in current["features"] if feature["objectId"] == "road")
        self.assertEqual(road["elevations"], [210] * 5)
        self.assertEqual(road["sourceGeometry"]["surface"]["rings"][0], source_ring(5))
        self.assertEqual(current["processing"]["appliedOperations"]["deleted"], 1)
        moved = self.make_file("change02.xml", [{"id": "road", "action": "u", "ring": source_ring(500)}], changes=True)
        current = dtm.import_sources([snapshot], self.route, "2026-09-30", changes=[change, moved])
        self.assertEqual({feature["objectId"] for feature in current["features"]}, {"platform"})

    def test_centroid_is_not_promoted_to_polygon(self):
        source = self.make_file("centroids.xml", [{"id": "point", "code": "0100000007", "suffix": "04"}])
        with self.assertRaisesRegex(ValueError, "No derived street polygon"):
            dtm.import_sources([source], self.route, "2026-09-30")

    def test_verified_grass_selection_and_relative_level_association(self):
        source = self.make_file("ground.xml", [
            {"id": "tram", "code": "0100000024"},
            {"id": "grass", "code": "0100000215"},
            {"id": "remoteGrass", "code": "0100000215", "ring": source_ring(80)},
            {"id": "railway", "code": "0100000312", "level": 1},
        ])
        to_native, to_wgs84, _ = dtm.coordinate_transform(self.route)
        lon, lat = to_wgs84.transform(-743000, -1043000)
        envelope = {"type": "Feature", "geometry": {"type": "MultiLineString", "coordinates": [
            [[point["lon"], point["lat"]] for point in self.route["points"]]]},
            "properties": {"selectionRadiusMeters": 1.6, "levelAssociations": [{
                "osmId": "way/123", "sourceRecordId": "dtm/tram/0", "sourceLevel": 0,
                "stationRange": {"from": 20, "to": 50}, "evidencePoint": {"lon": lon, "lat": lat}}]}}
        result = dtm.import_sources([source], self.route, "2026-09-30", track_envelope=envelope)
        self.assertEqual({feature["objectId"] for feature in result["features"]}, {"tram", "grass"})
        grass = next(feature for feature in result["features"] if feature["kind"] == "green")
        self.assertEqual(grass["surface"], "grass")
        self.assertEqual(grass["sourceGeometry"]["surface"]["rings"][0], source_ring())
        self.assertEqual(result["railwayStructures"][0]["dtmClass"], "0100000312")
        self.assertEqual(result["trackLevelAssociations"][0]["sourceLevel"], 0)
        envelope["properties"]["levelAssociations"][0]["sourceLevel"] = -1
        with self.assertRaisesRegex(ValueError, "association lacks matching"):
            dtm.import_sources([source], self.route, "2026-09-30", track_envelope=envelope)

    def test_unknown_precision_and_zero_height_are_preserved_honestly(self):
        source = self.make_file("zero.xml", [{"id": "unknown", "height": 0, "heightPrecision": 9}])
        feature = dtm.import_sources([source], self.route, "2026-09-30")["features"][0]
        self.assertEqual(feature["precisionHeight"], 9)
        self.assertEqual(feature["heightStatus"]["zero"], 5)
        self.assertEqual(feature["elevations"], [0] * 5)

    def test_conflicting_snapshot_and_wrong_daily_order_rejected(self):
        first = self.make_file("one.xml", [{"id": "same"}])
        second = self.make_file("two.xml", [{"id": "same", "height": 210}])
        with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
            dtm.import_sources([first, second], self.route, "2026-09-30")
        with self.assertRaisesRegex(ValueError, "chronologically"):
            dtm.import_sources([first], self.route, "2026-09-30", changes=[second, first])

    def test_bowtie_normalization_preserves_parity_and_original_edges(self):
        ring = [[-743010, -1043010], [-742990, -1042990], [-743010, -1042990],
                [-742990, -1043010], [-743010, -1043010]]
        source = self.make_file("bowtie.xml", [{"id": "bowtie", "ring": ring}])
        result = dtm.import_sources([source], self.route, "2026-09-30")
        self.assertEqual(len(result["features"]), 2)
        self.assertEqual(result["processing"]["repairedObjectIds"], ["bowtie"])
        repair = result["processing"]["normalization"][0]
        self.assertEqual(repair["evenOddAreaSquareMeters"], 200)
        self.assertEqual(repair["symmetricDifferenceAreaSquareMeters"], 0)
        self.assertGreater(repair["interpolatedVertices"], 0)
        for feature in result["features"]:
            self.assertEqual(feature["rawNativeGeometry"]["surface"]["rings"][0], ring)
            self.assertTrue(dtm.Polygon(feature["sourceGeometry"]["surface"]["rings"][0]).is_valid)
            self.assertTrue(all(height == 200.123 for height in feature["elevations"]))

    def test_ambiguous_intersection_z_remains_null(self):
        curves = [{"points": [[-1, -1, 200], [1, 1, 200]]},
                  {"points": [[-1, 1, 210], [1, -1, 210]]}]
        heights, status, provenance = dtm.vertex_heights([[[0, 0]]], curves)
        self.assertEqual(heights, [[None]])
        self.assertEqual(status["ambiguousIntersection"], 1)
        self.assertEqual(provenance[0]["method"], "ambiguous-intersection")
        self.assertEqual(len(provenance[0]["sourceSegments"]), 2)

    def test_lean_runtime_is_linked_to_lossless_gzip_source(self):
        source = self.make_file("snapshot.xml", [{"id": "road"}])
        result = dtm.import_sources([source], self.route, "2026-09-30")
        runtime_path, archive_path = self.directory / "runtime.json", self.directory / "source.json.gz"
        runtime = dtm.write_candidates(result, runtime_path, archive_path)
        archive_bytes = archive_path.read_bytes()
        self.assertEqual(runtime["sourceArchive"]["sha256"], hashlib.sha256(archive_bytes).hexdigest())
        original = json.loads(gzip.decompress(archive_bytes))
        self.assertEqual(original["features"][0]["sourceGeometry"], result["features"][0]["sourceGeometry"])
        self.assertNotIn("sourceGeometry", runtime["features"][0])
        self.assertEqual(runtime["features"][0]["sourceRecordId"], original["features"][0]["id"])


if __name__ == "__main__":
    unittest.main()
