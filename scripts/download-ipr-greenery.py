#!/usr/bin/env python3
"""Acquire Prague's shared greenery points (trees, shrubs, park furniture).

IPR Praha publishes the city's "Sdílená data o zeleni" as open data (CC BY,
"datový podklad © IPR Praha"). Two hosted point layers are read through their
public ArcGIS FeatureServer query endpoints:

* OPK_CUR_OPK_SMZ_VP_B  vegetation elements (individual trees, tree rows, shrubs)
* OPK_CUR_OPK_SMZ_TP_B  technical elements (benches, bins, lamps, statues, fountains)

Both layers are stored in Web Mercator (EPSG:3857). Requesting WGS84 output is
therefore an exact datum-free conversion, not a reprojection between datums.
The raw paged responses are kept with SHA-256 in the cache so that the runtime
extraction (scripts/extract-ipr-greenery.mjs) can be reproduced offline:

  python3 scripts/download-ipr-greenery.py --cache-dir /private/tmp/linka-ipr-greenery --download
"""

import argparse
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SERVICE = "https://mp.iprpraha.cz/arcgis/rest/services/Hosted/{layer}/FeatureServer/0"
LAYERS = {
    "vegetation": {
        "layer": "OPK_CUR_OPK_SMZ_VP_B",
        "title": "Sdílená data o zeleni - vegetační prvky - body",
        "catalogue": "https://opendata.geoportalpraha.cz/datasets/iprpraha::sdílená-data-o-zeleni-vegetační-prvky-body-1",
    },
    "technical": {
        "layer": "OPK_CUR_OPK_SMZ_TP_B",
        "title": "Sdílená data o zeleni - technické prvky - body",
        "catalogue": "https://opendata.geoportalpraha.cz/datasets/iprpraha::sdílená-data-o-zeleni-technické-prvky-body-1",
    },
}
USER_AGENT = "Linka22 public Prague greenery source preparation"
PAGE = 2000


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url):
    last_error = None
    for attempt in range(4):
        try:
            with urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=90) as response:
                return response.read()
        except Exception as error:  # network retry only
            last_error = error
            time.sleep(1 + attempt * 2)
    raise RuntimeError(f"IPR greenery read failed for {url}: {last_error}")


def route_envelope(route_path, margin_m):
    route = json.loads(route_path.read_text("utf-8"))
    lats = [point["lat"] for point in route["points"]]
    lons = [point["lon"] for point in route["points"]]
    dlat = margin_m / 111_320
    dlon = margin_m / 71_500
    return min(lons) - dlon, min(lats) - dlat, max(lons) + dlon, max(lats) + dlat


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--route", type=Path, default=Path("public/data/route22.json"))
    parser.add_argument("--margin", type=float, default=900)
    args = parser.parse_args()
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    west, south, east, north = route_envelope(args.route, args.margin)
    manifest = {
        "sourceName": "IPR Praha / Sdílená data o zeleni",
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "rulesUrl": "https://geoportalpraha.cz/backend/getdokument/1",
        "envelopeWgs84": [west, south, east, north],
        "layers": {},
    }
    for key, layer in LAYERS.items():
        base = SERVICE.format(layer=layer["layer"])
        pages = []
        metadata_file = args.cache_dir / f"{key}-layer.json"
        if args.download:
            metadata_file.write_bytes(fetch(base + "?f=json"))
        offset = 0
        while True:
            page_file = args.cache_dir / f"{key}-{offset:07d}.json"
            if args.download and not page_file.exists():
                query = urlencode({
                    "where": "1=1",
                    "geometry": f"{west},{south},{east},{north}",
                    "geometryType": "esriGeometryEnvelope",
                    "inSR": 4326,
                    "spatialRel": "esriSpatialRelIntersects",
                    "outFields": "*",
                    "returnGeometry": "true",
                    "outSR": 4326,
                    "orderByFields": "objectid",
                    "resultOffset": offset,
                    "resultRecordCount": PAGE,
                    "f": "json",
                })
                data = fetch(base + "/query?" + query)
                parsed = json.loads(data)
                if "error" in parsed:
                    raise RuntimeError(f"IPR service error: {parsed['error']}")
                page_file.write_bytes(data)
            if not page_file.exists():
                raise RuntimeError(f"Missing {page_file}; run with --download first")
            data = page_file.read_bytes()
            parsed = json.loads(data)
            pages.append({
                "file": page_file.name, "offset": offset,
                "features": len(parsed.get("features", [])),
                "sha256": sha256_bytes(data), "bytes": len(data),
            })
            print(f"{key}: offset {offset}, {len(parsed.get('features', []))} features", flush=True)
            if not parsed.get("exceededTransferLimit") and len(parsed.get("features", [])) < PAGE:
                break
            offset += PAGE
        layer_metadata = metadata_file.read_bytes()
        manifest["layers"][key] = {
            **layer,
            "service": base,
            "layerMetadataSha256": sha256_bytes(layer_metadata),
            "lastEditDate": json.loads(layer_metadata).get("editingInfo", {}).get("lastEditDate"),
            "pages": pages,
            "features": sum(page["features"] for page in pages),
        }
    (args.cache_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({key: value["features"] for key, value in manifest["layers"].items()}))


if __name__ == "__main__":
    main()
