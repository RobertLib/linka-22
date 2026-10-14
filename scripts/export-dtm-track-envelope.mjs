// Export actual directed rail alignment used only to select complete grassy
// source polygons. The importer never clips a native footprint to this line.
import fs from "node:fs";
import { Route } from "../src/route.js";
import { createStreetSurfaceLookup } from "../src/street-surfaces.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/export-dtm-track-envelope.mjs /tmp/rail-envelope.json");
const load = (name) => JSON.parse(fs.readFileSync(`public/data/${name}.json`));
const data = load("route22"), city = load("city"), network = load("street-network"), surfaces = load("street-surfaces");
Object.assign(city, { roads: network.roads, rails: network.rails, streetSurfaces: surfaces });
const route = new Route(data, null, city), lookup = createStreetSurfaceLookup(route, surfaces);
const coordinates = [route.points.map((point) => {
  const ll = route.unproject(point.x, point.z);
  return [ll.lon, ll.lat];
})];
let opposing = [];
for (let s = 0; s <= route.length; s += 1) {
  if (!route.trackInfo(s, -1)) {
    if (opposing.length > 1) coordinates.push(opposing);
    opposing = [];
    continue;
  }
  const point = route.trackAt(s, -1), ll = route.unproject(point.x, point.z);
  opposing.push([ll.lon, ll.lat]);
}
if (opposing.length > 1) coordinates.push(opposing);
const levelAssociations = [1, -1].map((direction) => {
  const osmId = direction === 1 ? "way/1168934249" : "way/1168934253";
  const stations = [];
  for (let s = 18000; s < 18300; s++)
    if (route.trackInfo(s, direction)?.osmId === osmId &&
        lookup.at(route.trackAt(s, direction), ["tram"], 0)?.objectId === "1000150380609") stations.push(s);
  if (!stations.length) throw new Error(`Native tram footprint does not support ${osmId}`);
  const point = route.trackAt(18150, direction), evidencePoint = route.unproject(point.x, point.z);
  return {
    osmId, sourceRecordId: "dtm/1000150380609/0", sourceObjectId: "1000150380609", sourceLevel: 0,
    stationRange: { from: stations[0], to: stations.at(-1) }, evidencePoint,
    overlyingBridgeRecordId: "dtm/1000150380904/0",
    reason: "Native DTM tram surface is level 0 beneath a level 1 railway bridge; OSM tunnel layer -1 is a separate relative-order convention. Apply only inside this native source footprint.",
  };
});
fs.writeFileSync(output, JSON.stringify({
  type: "Feature", geometry: { type: "MultiLineString", coordinates },
  properties: {
    source: "Current simulation directed OSM rail alignment; primary original vertices and opposing track samples 1 m; selection envelope only, no polygon clipping.",
    routeLength: route.length, selectionRadiusMeters: 1.6, levelAssociations,
  },
}));
console.log(`Actual rail selection envelope exported to ${output}; ${levelAssociations.length} explicitly supported source-level associations.`);
