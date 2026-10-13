"""Offline regression fixtures for conservative OSM building-part enrichment."""
import copy
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("parts", Path(__file__).with_name("enrich_building_parts.py"))
parts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parts)

# Six-metre-scale footprints in WGS84, matching the production data format.
origin = (50.075, 14.42)
lat_scale = 111320
lon_scale = lat_scale * __import__("math").cos(__import__("math").radians(origin[0]))
ll = lambda x, y: [origin[0] + y / lat_scale, origin[1] + x / lon_scale]
ring = lambda x0, y0, x1, y1: [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1), ll(x0, y0)]
base = {"osmId": "way/1", "points": ring(0, 0, 20, 12), "height": 3.3,
        "levels": 1, "heightSource": "levels", "type": "residential"}


def run(tagged_rings, building=None):
    city = {"buildings": [copy.deepcopy(building or base)]}
    nodes, ways = {}, {"1": {"nodes": [], "tags": {"building": "yes", "building:levels": "1"}}}
    for i, (coords, tags) in enumerate(tagged_rings, 10):
        ids = []
        for j, coordinate in enumerate(coords[:-1]):
            identity = f"{i}:{j}"
            nodes[identity] = tuple(coordinate)
            ids.append(identity)
        ids.append(ids[0])
        ways[str(i)] = {"nodes": ids, "tags": {"building:part": "yes", **tags}}
    before = copy.deepcopy(city["buildings"][0]["points"])
    summary, _, _ = parts.enrich(city, nodes, ways, {}, [])
    assert city["buildings"][0]["points"] == before
    assert len(city["buildings"]) == 1
    again = copy.deepcopy(city)
    parts.enrich(again, nodes, ways, {}, [])
    assert again == city, "repeat enrichment is exactly idempotent"
    return city["buildings"][0], summary


building, summary = run([
    (ring(0, 0, 17, 12), {"height": "15", "roof:height": "4", "building:levels": "3", "roof:shape": "mansard"}),
    (ring(17, 0, 20, 12), {"height": "11", "roof:shape": "flat"}),
    # A tiny, recorded tower must never increase the height of the whole house.
    (ring(5, 5, 7, 7), {"height": "100", "roof:shape": "flat"}),
])
assert summary["updatedBuildings"] == 1
assert building["height"] == 11
assert building["levels"] == 3
assert building["heightSource"] == "OSM"
assert building["buildingParts"]["heightInterpretation"] == "eaves"
assert building["buildingParts"]["eavesSource"] == "height-minus-roof:height"
assert building["buildingParts"]["roofHeight"] == 4
assert building["buildingParts"]["original"]["height"] == 3.3
assert building["buildingParts"]["original"]["osmTags"] == {"building:levels": "1"}

for fixture in [
    [(ring(0, 0, 10, 12), {"building:levels": "3"}), (ring(10, 0, 20, 12), {"building:levels": "8"})],
    [(ring(0, 0, 6, 12), {"building:levels": "3"})],
    [(ring(0, 0, 20, 12), {"height": "50", "min_height": "40", "roof:shape": "flat"})],
    [(ring(0, 0, 20, 12), {"height": "50", "building:part": "roof", "roof:shape": "flat"})],
    [(ring(30, 0, 50, 12), {"height": "50", "roof:shape": "flat"})],
]:
    untouched, summary = run(fixture)
    assert summary["updatedBuildings"] == 0
    assert untouched["height"] == 3.3
    assert untouched["levels"] == 1

with_hole = {**base, "holes": [ring(7, 3, 13, 9)]}
untouched, summary = run([(ring(8, 4, 12, 8), {"height": "50", "roof:shape": "flat"})], with_hole)
assert summary["assignedParts"] == 0, "a separate object in a courtyard is not an enclosing building's part"
assert parts.number("125 m") == 125
assert parts.number("4.5") == 4.5
assert parts.number("3;5") is None
print("Building parts passed: coherent primary eaves, source provenance, tower/elevated/roof rejection, courtyard containment, unchanged footprints and idempotence.")
