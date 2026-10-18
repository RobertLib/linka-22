#!/usr/bin/env python3
"""Extract the published line 22 timetable for the simulated itinerary.

  curl -o /private/tmp/PID_GTFS.zip https://data.pid.cz/PID_GTFS.zip
  python3 scripts/import-timetable.py /private/tmp/PID_GTFS.zip

Only trips whose complete stop sequence equals the simulated directional
stops are kept: the full Bílá Hora route and the published trips that start
at Vypich and then follow exactly the same stops. Diversions (for example via
Hradčanská), depot runs and shortened trips keep their own timetables in the
feed and are deliberately excluded. Times are retained exactly as published
(PID publishes whole minutes); nothing is interpolated or invented.
"""

import argparse
import csv
from datetime import date
import hashlib
import io
import json
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent.parent
ROUTE = ROOT / "public" / "data" / "route22.json"
OUTPUT = ROOT / "public" / "data" / "timetable22.json"
SOURCE_URL = "https://data.pid.cz/PID_GTFS.zip"
LICENSE_URL = "https://pid.cz/o-systemu/opendata/"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def table(archive, name):
    with archive.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig"))


def minutes(clock):
    hours, mins, secs = (int(part) for part in clock.split(":"))
    if secs:
        raise ValueError(f"unexpected seconds in published time {clock}")
    return hours * 60 + mins


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("gtfs", type=Path, help="downloaded PID_GTFS.zip")
    parser.add_argument("--downloaded", default=date.today().isoformat())
    args = parser.parse_args()
    route = json.loads(ROUTE.read_text(encoding="utf-8"))
    stop_ids = [stop["id"] for stop in route["stops"]]
    with ZipFile(args.gtfs) as archive:
        feed = next(table(archive, "feed_info.txt"))
        line = next(r for r in table(archive, "routes.txt") if r["route_short_name"] == "22" and r["route_type"] == "0")
        trips = {t["trip_id"]: t for t in table(archive, "trips.txt") if t["route_id"] == line["route_id"]}
        stop_times = {}
        for row in table(archive, "stop_times.txt"):
            if row["trip_id"] in trips:
                stop_times.setdefault(row["trip_id"], []).append(row)
        calendar = {row["service_id"]: row for row in table(archive, "calendar.txt")}
        exceptions = {}
        for row in table(archive, "calendar_dates.txt"):
            exceptions.setdefault(row["service_id"], []).append(row)

    selected = []
    for trip_id, rows in stop_times.items():
        rows.sort(key=lambda r: int(r["stop_sequence"]))
        ids = [r["stop_id"] for r in rows]
        first = len(stop_ids) - len(ids)
        if first < 0 or ids != stop_ids[first:] or first not in (0, 3):
            continue
        trip = trips[trip_id]
        if any(r["arrival_time"] != r["departure_time"] for r in rows):
            raise ValueError(f"{trip_id}: separate arrival and departure times are not modelled")
        selected.append(
            {
                "id": trip_id,
                "service": trip["service_id"],
                "block": trip["block_id"] or None,
                "shape": trip["shape_id"],
                "headsign": trip["trip_headsign"],
                "firstStop": first,
                "lowFloor": trip["wheelchair_accessible"] == "1",
                "exceptional": trip.get("exceptional") == "1",
                "minutes": [minutes(r["departure_time"]) for r in rows],
                "request": [i + first for i, r in enumerate(rows) if r["pickup_type"] == "3" or r["drop_off_type"] == "3"],
            }
        )
    selected.sort(key=lambda t: (t["minutes"][0] - (0 if t["firstStop"] == 0 else 4), t["id"]))
    request = sorted({i for trip in selected for i in trip["request"]})
    for trip in selected:
        if trip["request"] != [i for i in request if i >= trip["firstStop"]]:
            raise ValueError(f"{trip['id']}: request stops differ from the other trips")
        del trip["request"]
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    services = {}
    for service_id in sorted({trip["service"] for trip in selected}):
        row = calendar[service_id]
        services[service_id] = {
            "days": [int(row[day]) for day in days],
            "start": row["start_date"],
            "end": row["end_date"],
            "added": sorted(r["date"] for r in exceptions.get(service_id, []) if r["exception_type"] == "1"),
            "removed": sorted(r["date"] for r in exceptions.get(service_id, []) if r["exception_type"] == "2"),
        }
    output = {
        "attribution": "Jízdní řády: ROPID / Pražská integrovaná doprava, CC BY 4.0",
        "licenseUrl": LICENSE_URL,
        "source": {
            "url": SOURCE_URL,
            "publisher": feed["feed_publisher_name"],
            "feedStart": feed["feed_start_date"],
            "feedEnd": feed["feed_end_date"],
            "downloaded": args.downloaded,
            "sha256": sha256(args.gtfs),
            "routeId": line["route_id"],
        },
        "timeZone": "Europe/Prague",
        "stopIds": stop_ids,
        "requestStops": request,
        "services": services,
        "trips": selected,
        "limitations": [
            "PID publikuje odjezdy v celých minutách; příjezd a odjezd jsou v těchto spojích shodné.",
            "Zahrnuty jsou jen spoje s přesně stejnou posloupností zastávek jako simulovaná trasa; výlukové objízdné varianty a vozovnové jízdy nejsou.",
            "Kalendář platí pouze v období vydaného feedu; po jeho skončení hra používá poslední platné dny se stejným typem dne.",
        ],
    }
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    full = sum(t["firstStop"] == 0 for t in selected)
    print(f"{OUTPUT.relative_to(ROOT)}: {len(selected)} trips ({full} from Bílá Hora), request stops {request}")


if __name__ == "__main__":
    main()
