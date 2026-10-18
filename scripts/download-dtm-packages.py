#!/usr/bin/env python3
"""Acquire public current Prague DTM packages without a login or data request.

Prepare the eight line-22/100 m corridor district snapshots and subsequent
Prague-wide daily changes:
  python3 scripts/download-dtm-packages.py --cache-dir /private/tmp/linka-dtm-current --download
Verify/rebuild the manifest offline from that cache:
  python3 scripts/download-dtm-packages.py --cache-dir /private/tmp/linka-dtm-current
Acquire the complete public ZPS drawing (fences, walls, railings, stairs, poles):
  python3 scripts/download-dtm-packages.py --content zps-drawing --date 2026-10-18 --cache-dir /private/tmp/linka-dtm-drawing --download
Acquire public DI including individual tram-track axes:
  python3 scripts/download-dtm-packages.py --content di --cache-dir /private/tmp/linka-dtm-tracks-current --download

The official anonymous DMVS public catalogue publishes JVF XML ZIP files.
The current frontend's OpenDataService POST requests only retrieve catalogue
metadata and existing URLs; they do not submit a data-extraction request.
Snapshot and update dates come from the catalogue and archive filenames.
--date is the requested client-facing cutoff, not an asserted survey date.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen
from zipfile import ZipFile


API = "https://dmvs.cuzk.gov.cz/api/rest/open-data/datove-sady"
CATALOGUE = "https://dmvs.cuzk.gov.cz/portal/vydej-dat/verejne-datove-sady"
CONTENT_TYPES = {
    "zps-derived": {"code": "ZpsOdvozenePlosneTypyObjektu", "suffix": "ZPS_OPL", "label": "ZPS"},
    "zps-drawing": {"code": "ZpsKresba", "suffix": "ZPS_KR", "label": "ZPS (kresba)"},
    "di": {"code": "Di", "suffix": "DI", "label": "DI"},
}
REGION = "CZ010"
DISTRICTS = [1, 2, 3, 5, 6, 10, 15, 17]
SOURCE_DESCRIPTION = "https://www.cuzk.gov.cz/DMVS/Poskytovani-dat.aspx"
RULES_URL = "https://geoportalpraha.cz/backend/getdokument/1"
USER_AGENT = "Linka22 public Prague DTM source preparation"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request_with_retry(url, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"User-Agent": USER_AGENT}
    if data is not None:
        headers["Content-Type"] = "application/json"
    last_error = None
    for attempt in range(3):
        try:
            return urlopen(Request(url, data=data, headers=headers), timeout=45)
        except Exception as error:
            last_error = error
            if attempt < 2:
                time.sleep(attempt + 1)
    raise RuntimeError(f"Public DTM read failed for {url}: {last_error}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--date", type=date.fromisoformat, default=date(2026, 10, 14))
    parser.add_argument("--snapshot-date", type=date.fromisoformat)
    parser.add_argument("--districts", default=",".join(map(str, DISTRICTS)))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--content", choices=sorted(CONTENT_TYPES), default="zps-derived")
    args = parser.parse_args()
    content = CONTENT_TYPES[args.content]
    archive_name = re.compile(
        r"^(?:VS_CZ010_MOMC_(?P<district>\d+)_(?P<state>\d{8})|"
        r"VZ_CZ010_(?P<change>\d{8}))_" + re.escape(content["suffix"]) + r"\.jvf\.zip$"
    )
    snapshot_date = args.snapshot_date or args.date.replace(day=1) - timedelta(days=1)
    if snapshot_date >= args.date:
        parser.error("Snapshot must precede the requested cutoff")
    selected_districts = sorted(set(int(value) for value in args.districts.split(",")))
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    metadata_sources = []

    def catalogue(name, endpoint, body):
        output = args.cache_dir / name
        url = API + endpoint
        if args.download:
            with request_with_retry(url, body) as response:
                data = response.read()
            if name.endswith(".json"):
                item = json.loads(data)
                if "status" in item and int(item["status"]) >= 400:
                    raise RuntimeError(f"Public catalogue error: {item}")
            output.write_bytes(data)
        if not output.exists():
            raise RuntimeError(f"Missing metadata {output}; run with --download first")
        metadata_sources.append({
            "file": output.name,
            "url": url,
            "method": "POST",
            "body": body,
            "sha256": sha256(output),
            "bytes": output.stat().st_size,
        })
        return output.read_text("utf-8")

    district_query = {
        "getTotal": True, "from": 0, "size": 100,
        "filter": {"nazev": "Praha"}, "orderBy": ["nazev;asc"],
    }
    district_result = json.loads(catalogue("districts.json", "/momc/query", district_query))
    if district_result.get("total", 0) > len(district_result.get("items", [])):
        raise RuntimeError("Public district query was truncated; refusing incomplete identifiers")
    by_name = {item["nazev"]: item for item in district_result["items"]}
    districts = []
    for number in selected_districts:
        label = f"Praha {number}"
        item = by_name.get(label)
        if not item or item["obec"]["kraj"] != REGION:
            raise RuntimeError(f"Public source did not provide the expected district {label}")
        districts.append({"number": number, "name": label, "code": item["kod"]})

    state_body = {
        "isDtmk": [REGION], "datumOd": snapshot_date.isoformat(),
        "momc": [district["code"] for district in districts], "obsah": [content["code"]],
    }
    change_start = snapshot_date + timedelta(days=1)
    change_body = {
        "isDtmk": [REGION], "datumOd": change_start.isoformat(),
        "datumDo": args.date.isoformat(), "obsah": [content["code"]],
    }
    state_stamp = snapshot_date.strftime("%Y%m%d")
    change_stamp = f"{change_start:%Y%m%d}-{args.date:%Y%m%d}"
    state_info = json.loads(catalogue(
        f"states-{state_stamp}-info.json", "/stavove/info", state_body,
    ))
    state_urls = catalogue(f"states-{state_stamp}-urls.txt", "/stavove/seznam-url", state_body)
    change_info = json.loads(catalogue(
        f"changes-{change_stamp}-info.json", "/zmenove/info", change_body,
    ))
    change_urls = catalogue(
        f"changes-{change_stamp}-urls.txt", "/zmenove/seznam-url", change_body,
    )
    codes = {str(district["code"]) for district in districts}
    packages = []
    for line in (state_urls + "\n" + change_urls).splitlines():
        url = line.strip()
        if not url:
            continue
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "isdtmk.dtm-praha-sck.cz":
            raise RuntimeError(f"Unexpected public archive host: {url}")
        filename = unquote(Path(parsed.path).name)
        match = archive_name.fullmatch(filename)
        if not match:
            raise RuntimeError(f"Unexpected public archive name: {filename}")
        if match["state"]:
            if match["district"] not in codes or match["state"] != state_stamp:
                raise RuntimeError(f"Catalogue returned an unexpected snapshot: {filename}")
            kind, source_date = "snapshot", snapshot_date
        else:
            source_date = date.fromisoformat(
                f"{match['change'][:4]}-{match['change'][4:6]}-{match['change'][6:8]}"
            )
            if not change_start <= source_date <= args.date:
                raise RuntimeError(f"Catalogue returned an out-of-range update: {filename}")
            kind = "daily-change"
        packages.append({
            "file": filename, "url": url, "kind": kind,
            "sourceDate": source_date.isoformat(),
            "districtCode": int(match["district"]) if match["district"] else None,
        })
    if len({item["file"] for item in packages}) != len(packages):
        raise RuntimeError("Public catalogue repeated an archive; refusing ambiguous sequence")
    if {str(item["districtCode"]) for item in packages if item["kind"] == "snapshot"} != codes:
        raise RuntimeError("Public catalogue omitted one or more requested district snapshots")
    packages.sort(key=lambda item: (item["sourceDate"], item["kind"], item["districtCode"] or 0))
    print(f"Selected {len(districts)} district snapshots and "
          f"{sum(item['kind'] == 'daily-change' for item in packages)} daily updates", flush=True)

    def acquire(package):
        output = args.cache_dir / package["file"]
        if args.download and not output.exists():
            print(f"Downloading {package['file']}", flush=True)
            temporary = output.with_name(output.name + ".partial")
            with request_with_retry(package["url"]) as response, temporary.open("wb") as target:
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    target.write(chunk)
            temporary.replace(output)
        if not output.exists():
            raise RuntimeError(f"Missing archive {output}; run with --download first")
        with ZipFile(output) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise RuntimeError(f"Corrupt JVF archive {output}: {bad_member}")
            members = [{"file": item.filename, "bytes": item.file_size}
                       for item in archive.infolist()]
            if not any(item["file"].endswith(".jvf.xml") for item in members):
                raise RuntimeError(f"Archive contains no JVF XML: {output}")
        result = {
            **package, "sha256": sha256(output), "bytes": output.stat().st_size,
            "members": members,
        }
        print(f"Verified {output.name}: {result['bytes']} bytes", flush=True)
        return result

    with ThreadPoolExecutor(max_workers=4) as pool:
        packages = list(pool.map(acquire, packages))
    available_dates = {item["sourceDate"] for item in packages if item["kind"] == "daily-change"}
    requested_dates = set()
    current = change_start
    while current <= args.date:
        requested_dates.add(current.isoformat())
        current += timedelta(days=1)
    license_metadata = {
        "attribution": "datový podklad © IPR Praha",
        "license": "CC BY 4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "rulesUrl": RULES_URL,
        "licenseBasis": "IPR public geographic data and map download-service rules, HMP resolution 80 of 22 January 2024, section I.8; selected region is Prague CZ010.",
    } if args.content.startswith("zps") else {
        "attribution": "Source: public DI DTM Praha via ČÚZK DMVS; original owner, operator and editor IDs retained in JVF records",
        "license": None,
        "licenseUrl": None,
        "rulesUrl": SOURCE_DESCRIPTION,
        "licenseBasis": "Official DMVS documentation explicitly provides anonymous public DI downloads. Catalogue responses and downloaded JVF archives contain no explicit redistribution licence; the separate ZPS/IPR licence is not asserted for operator-authored DI geometry.",
    }
    manifest = {
        "sourceName": "Digitální technická mapa Prahy a Středočeského kraje / veřejné " + content["label"],
        "catalogueUrl": CATALOGUE,
        "sourceDocumentationUrl": SOURCE_DESCRIPTION,
        **license_metadata,
        "access": "Anonymous public pre-generated state and daily-change packages; no login/data request",
        "content": content["code"],
        "region": REGION,
        "requestedAsOfDate": args.date.isoformat(),
        "snapshotDate": snapshot_date.isoformat(),
        "latestDailyUpdateDate": max(available_dates) if available_dates else None,
        "requestedDatesWithoutPublishedArchive": sorted(requested_dates - available_dates),
        "districts": districts,
        "catalogueStateInfo": state_info,
        "catalogueChangeInfo": change_info,
        "metadataSources": metadata_sources,
        "packages": packages,
        "processingOrder": "All district snapshots first (deduplicate source IDs), then daily changes in ascending sourceDate; preserve JVF r/i/u/d operations.",
        "limitations": [
            "Archive/snapshot dates are publication dates, not a guarantee of a recent survey for every object.",
            "No archive is invented for a requested date absent from the official catalogue.",
            "Projected JVF geometry requires format-aware parsing; preserve complete source coordinates, level, Z and accuracy attributes.",
            "Physical geometry does not itself establish legal traffic access or travel direction. Zero, missing or partial Z is not a surveyed altitude.",
        ],
    }
    manifest_path = args.manifest or args.cache_dir / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "manifest": str(manifest_path), "packages": len(packages),
        "bytes": sum(item["bytes"] for item in packages),
        "snapshotDate": manifest["snapshotDate"],
        "latestDailyUpdateDate": manifest["latestDailyUpdateDate"],
        "requestedDatesWithoutPublishedArchive": manifest["requestedDatesWithoutPublishedArchive"],
    }), flush=True)


if __name__ == "__main__":
    main()
