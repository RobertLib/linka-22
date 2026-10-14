#!/usr/bin/env python3
"""Offline source-integrity and daily-replay checks for the DI axis importer."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("axis_import", Path(__file__).with_name("import-dtm-track-axes.py"))
axis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(axis)
GML = "http://www.opengis.net/gml/3.2"


def write_xml(path, records, changes=False):
    root = ET.Element("JVFDTM")
    content = ET.SubElement(root, "DataJVFDTM")
    for name, value in [("VerzeJVFDTM", "1.4.3"), ("TypZapisu", "změnové věty" if changes else "kompletní zápis")]:
        ET.SubElement(content, name).text = value
    data = ET.SubElement(content, "Data")
    for record in records:
        group = ET.SubElement(data, "ObjectClass")
        ET.SubElement(group, "ObjektovyTypNazev", code_base=record.get("class", "0100000027"), code_suffix="02").text = "axis"
        entry = ET.SubElement(ET.SubElement(group, "ZaznamyObjektu"), "ZaznamObjektu")
        ET.SubElement(entry, "ZapisObjektu").text = record.get("action", "r")
        attributes = ET.SubElement(entry, "AtributyObjektu")
        for name, value in {"ID": record["id"], "UrovenUmisteniObjektuDI": record.get("level", 0),
                            "TridaPresnostiPoloha": record.get("position", 3), "TridaPresnostiVyska": 3,
                            "ZpusobPorizeniDI": record.get("acquisition", 1), "NeuplnaData": "true",
                            "DatumZmeny": "2026-09-20T01:02:03", "IDExterni": "original/external/source"}.items():
            ET.SubElement(attributes, name).text = str(value)
        if record.get("action") == "d":
            continue
        curve = ET.SubElement(ET.SubElement(entry, "GeometrieObjektu"), f"{{{GML}}}curveProperty")
        line = ET.SubElement(curve, f"{{{GML}}}LineString", srsName="EPSG:5514", srsDimension="3")
        dx = record.get("dx", 0)
        heights = record.get("heights", [200.5, 0.0, 201.25])
        ET.SubElement(line, f"{{{GML}}}posList").text = " ".join(str(value) for point in [
            [-743010 + dx, -1043000, heights[0]], [-743000 + dx, -1043000, heights[1]],
            [-742990 + dx, -1043000, heights[2]]] for value in point)
    ET.ElementTree(root).write(path, encoding="utf-8")


class AxisImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        transformer = axis.dtm.Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True)
        self.route = {"points": []}
        for s, x in [(0, -743020), (100, -742980)]:
            lon, lat = transformer.transform(x, -1043000)
            self.route["points"].append({"distance": s, "lat": lat, "lon": lon})

    def tearDown(self):
        self.temp.cleanup()

    def source(self, name, records, changes=False):
        path = self.path / name
        write_xml(path, records, changes)
        return path

    def test_filter_exact_native_xyz_zeros_and_lossless_archive(self):
        source = self.source("snapshot.xml", [{"id": "axis", "level": -1},
            {"id": "derived", "class": "0100000026", "position": 9, "acquisition": 5},
            {"id": "sketch", "position": 9, "acquisition": 4}])
        result = axis.import_axes([source, source], self.route, "2026-09-30")
        self.assertEqual(result["counts"]["features"], 1)
        self.assertEqual(result["counts"]["diagnosticAxes"], 1)
        self.assertEqual(result["counts"]["excludedAxes"], 1)
        feature = result["features"][0]
        self.assertEqual(feature["elevations"], [200.5, None, 201.25])
        self.assertEqual(feature["sourceGeometry"]["curve"]["points"][1][2], 0)
        self.assertIn("0.0", feature["sourceGeometry"]["curve"]["positionText"])
        self.assertEqual(feature["level"], -1)
        self.assertEqual(feature["attributes"]["IDExterni"], "original/external/source")
        runtime = axis.write_candidates(result, self.path / "candidate.json", self.path / "source.json.gz")
        compressed = (self.path / "source.json.gz").read_bytes()
        original = json.loads(gzip.decompress(compressed))
        self.assertEqual(runtime["sourceArchive"]["sha256"], hashlib.sha256(compressed).hexdigest())
        self.assertEqual(runtime["features"][0]["sourceRecordId"], original["features"][0]["id"])
        self.assertEqual(original["features"][0]["sourceGeometry"], feature["sourceGeometry"])
        self.assertNotIn("sourceGeometry", runtime["features"][0])

    def test_update_delete_reference_move_and_class_change(self):
        source = self.source("snapshot.xml", [{"id": "updated"}, {"id": "deleted"}, {"id": "changedClass"}, {"id": "moved"}])
        change = self.source("change01.xml", [{"id": "updated", "action": "u", "heights": [210, 211, 212]},
            {"id": "updated", "action": "r", "heights": [1, 1, 1]},
            {"id": "deleted", "action": "d"}, {"id": "moved", "action": "u", "dx": 500},
            {"id": "changedClass", "action": "u", "class": "0100009999"}], True)
        result = axis.import_axes([source], self.route, "2026-09-30", changes=[change])
        self.assertEqual([f["objectId"] for f in result["features"]], ["updated"])
        self.assertEqual(result["features"][0]["elevations"], [210, 211, 212])
        self.assertEqual(result["processing"]["appliedOperations"]["deleted"], 1)

    def test_conflicting_snapshots_bad_order_and_checksum_refused(self):
        source = self.source("source.xml", [{"id": "axis"}])
        conflict = self.source("conflict.xml", [{"id": "axis", "dx": 1}])
        with self.assertRaisesRegex(ValueError, "Conflicting duplicate"):
            axis.import_axes([source, conflict], self.route, "2026-09-30")
        with self.assertRaisesRegex(ValueError, "chronologically"):
            axis.import_axes([source], self.route, "2026-09-30", changes=[source, conflict])
        with self.assertRaisesRegex(ValueError, "checksum"):
            axis.import_axes([source], self.route, "2026-09-30", package_metadata={source.name: {"sha256": "bad"}})

    def test_old_proj_cannot_silently_apply_the_projected_grid(self):
        with patch.object(axis.dtm, "proj_version_str", "9.3.0"):
            with self.assertRaisesRegex(ValueError, "requires PROJ >= 9.4"):
                axis.dtm.coordinate_transform(self.route, self.path / "grid.tif")


if __name__ == "__main__":
    unittest.main()
