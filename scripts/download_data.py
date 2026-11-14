# /// script
# requires-python = ">=3.11"
# dependencies = ["mapbox-vector-tile>=2,<3", "shapely>=2,<3"]
# ///
"""Download the site's thermal detections, counts, and California boundaries.

Run: uv run scripts/download_data.py
Options: --end YYYY-MM-DD --cache-dir /path/to/cache --workers 6

FIRMS annual CSVs preserve inferred hotspot types. For dates newer than the
annual archive, use GIBS Terra vector tiles (type unavailable, saved as null).
Only the selected day's saved point file is requested by the website. AOD is
still live GIBS imagery, not downloaded by this script. Missing downloads are
recorded as unavailable; they are never written as zero-count days.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import mapbox_vector_tile
from shapely.geometry import Point, shape
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "docs" / "data"
FIRMS = "https://firms.modaps.eosdis.nasa.gov"
GIBS = "https://gibs.earthdata.nasa.gov"
START = dt.date(2000, 2, 24)


def download(url: str, destination: Path) -> bytes:
    if destination.exists():
        return destination.read_bytes()
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "DSC106-MODIS-visualization/1.0"}
            )
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = response.read()
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + ".tmp")
            temporary.write_bytes(payload)
            temporary.replace(destination)
            return payload
        except urllib.error.HTTPError as error:
            if error.code in (404, 400):
                raise
            if attempt == 2:
                raise
        except (OSError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(attempt + 1)
    raise RuntimeError(url)


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, separators=(",", ":"), allow_nan=False) + "\n"
    )
    temporary.replace(path)


def topology_feature(topology, geometry):
    """Decode quantized TopoJSON arcs, including reversed arcs and holes."""
    transform = topology["transform"]

    def arc(index):
        x = y = 0
        points = []
        for dx, dy in topology["arcs"][index if index >= 0 else ~index]:
            x += dx
            y += dy
            points.append(
                [
                    x * transform["scale"][0] + transform["translate"][0],
                    y * transform["scale"][1] + transform["translate"][1],
                ]
            )
        return points if index >= 0 else points[::-1]

    def ring(indices):
        result = []
        for index in indices:
            result.extend(arc(index)[:-1])
        result.append(result[0])
        return result

    if geometry["type"] == "Polygon":
        coordinates = [ring(indices) for indices in geometry["arcs"]]
    elif geometry["type"] == "MultiPolygon":
        coordinates = [
            [ring(indices) for indices in polygon] for polygon in geometry["arcs"]
        ]
    else:
        raise ValueError("Unexpected boundary geometry")
    return {
        "type": "Feature",
        "id": geometry["id"],
        "properties": geometry.get("properties", {}),
        "geometry": {"type": geometry["type"], "coordinates": coordinates},
    }


def boundaries(cache):
    sources = {
        "states": "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
        "counties": "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json",
    }
    states = json.loads(download(sources["states"], cache / "states-10m.json"))
    counties = json.loads(download(sources["counties"], cache / "counties-10m.json"))
    california = topology_feature(
        states,
        next(g for g in states["objects"]["states"]["geometries"] if int(g["id"]) == 6),
    )
    features = [
        topology_feature(counties, g)
        for g in counties["objects"]["counties"]["geometries"]
        if str(g["id"]).zfill(5).startswith("06")
    ]
    if len(features) != 58:
        raise ValueError(f"Expected 58 counties, got {len(features)}")
    save(DATA / "california.json", california)
    save(
        DATA / "california-counties.json",
        {"type": "FeatureCollection", "features": features},
    )
    mask = prep(shape(california["geometry"]))
    # Static pixel-center mask: the browser must not run polygon containment
    # tens of thousands of times after every daily AOD image arrives.
    width, height = 240, 223
    indices = [
        y * width + x
        for y in range(height)
        for x in range(width)
        if mask.covers(
            Point(-125 + (x + 0.5) / width * 11, 42.2 - (y + 0.5) / height * 10.2)
        )
    ]
    save(
        DATA / "aod-grid.json",
        {
            "width": width,
            "height": height,
            "bounds": [-125, 32, -114, 42.2],
            "indices": indices,
        },
    )
    return mask, sources


def numeric(value):
    return None if value is None or str(value).strip() == "" else float(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    yesterday = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=1)
    parser.add_argument("--end", type=dt.date.fromisoformat, default=yesterday)
    parser.add_argument(
        "--cache-dir", type=Path, default=ROOT / ".cache" / "modis-downloads"
    )
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument(
        "--boundaries-only",
        action="store_true",
        help="Refresh boundaries and AOD pixel mask only",
    )
    args = parser.parse_args()
    if args.end < START or args.end > yesterday or not 1 <= args.workers <= 12:
        parser.error(
            f"Choose an end date between {START} and yesterday (UTC); workers must be 1–12"
        )
    cache = args.cache_dir
    california, boundary_sources = boundaries(cache)
    if args.boundaries_only:
        print("Saved state/county boundaries and AOD pixel mask", flush=True)
        return
    # Coverage of the exact Terra layer. Missing mission days must not be
    # interpreted as successful days with zero thermal detections.
    capabilities_url = GIBS + "/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
    root = ET.fromstring(
        download(
            capabilities_url,
            cache / f"capabilities-{dt.datetime.now(dt.timezone.utc).date()}.xml",
        )
    )
    thermal_coverage = []
    for layer in root.findall(".//{*}Layer"):
        identifier = layer.find("{*}Identifier")
        if (
            identifier is not None
            and identifier.text == "MODIS_Terra_Thermal_Anomalies_All"
        ):
            for value in layer.findall("{*}Dimension/{*}Value"):
                parts = value.text.split("/")
                thermal_coverage.append(
                    [parts[0][:10], parts[1][:10] if len(parts) > 1 else parts[0][:10]]
                )
    if not thermal_coverage:
        raise ValueError("Could not verify Terra thermal coverage")

    def has_thermal(date):
        return any(start <= str(date) <= end for start, end in thermal_coverage)

    dates = [START + dt.timedelta(days=i) for i in range((args.end - START).days + 1)]
    counts = {}
    sources = {}
    failures = {}

    def finish(date, records, source):
        # One clipping rule for the saved map records and their count table.
        records = [row for row in records if california.covers(Point(row[0], row[1]))]
        save(DATA / "thermal" / f"{date}.json", records)
        groups = Counter(
            (
                row[8] if row[8] in (0, 1, 2, 3) else -1,
                row[4] if row[4] is not None else -1,
            )
            for row in records
            if row[2] == "Terra"
        )
        counts[date] = (
            [
                [kind, confidence, count]
                for (kind, confidence), count in sorted(groups.items())
            ]
            if has_thermal(date)
            else None
        )
        sources[date] = source

    catalog = download(
        FIRMS + "/data/country/yearly_summary_files.txt",
        cache / f"catalog-{dt.date.today()}.txt",
    ).decode()
    live_dates = []
    for year in range(START.year, args.end.year + 1):
        year_dates = [date for date in dates if date.year == year]
        filename = f"modis_{year}_United_States.csv"
        if not any(line.startswith(filename + ",") for line in catalog.splitlines()):
            live_dates.extend(date for date in year_dates if has_thermal(date))
            continue
        source = f"{FIRMS}/data/country/modis/{year}/{filename}"
        payload = download(source, cache / filename).decode("utf-8-sig")
        by_day = {str(date): [] for date in year_dates}
        latest = None
        for row in csv.DictReader(io.StringIO(payload)):
            day = row["acq_date"]
            latest = max(latest or day, day)
            if day not in by_day:
                continue
            lat, lon = float(row["latitude"]), float(row["longitude"])
            if not (-125 <= lon <= -114 and 32 <= lat <= 42.2):
                continue
            by_day[day].append(
                [
                    lon,
                    lat,
                    row["satellite"],
                    row["acq_time"].zfill(4),
                    numeric(row["confidence"]),
                    numeric(row["frp"]),
                    numeric(row["brightness"]),
                    row["daynight"],
                    int(row["type"]) if row.get("type") else None,
                ]
            )
        for day, records in by_day.items():
            if latest and day <= latest:
                finish(day, records, source)
            else:
                if has_thermal(day):
                    live_dates.append(dt.date.fromisoformat(day))
        print(f"{year}: prepared archive records", flush=True)

    def live_day(date):
        day = str(date)
        source = f"{GIBS}/wmts/epsg4326/best/MODIS_Terra_Thermal_Anomalies_All/default/{day}/1km/3/1/1.mvt"
        # Recent daily tiles can be revised as late observations arrive.
        path = cache / "tiles" / f"{day}.mvt"
        if date >= yesterday - dt.timedelta(days=2):
            path.unlink(missing_ok=True)
        payload = download(source, path)
        if payload[:2] == b"\x1f\x8b":
            payload = gzip.decompress(payload)
        layers = mapbox_vector_tile.decode(payload)
        records, seen = [], set()
        for layer in layers.values():
            for feature in layer["features"]:
                p = feature["properties"]
                if str(p.get("ACQ_DATE", ""))[:10] != day:
                    continue
                lon, lat = numeric(p.get("LONGITUDE")), numeric(p.get("LATITUDE"))
                if (
                    lon is None
                    or lat is None
                    or not (-125 <= lon <= -114 and 32 <= lat <= 42.2)
                ):
                    continue
                identity = p.get("UID", (lon, lat, p.get("ACQ_TIME"), p.get("FRP")))
                if identity in seen:
                    continue
                seen.add(identity)
                records.append(
                    [
                        lon,
                        lat,
                        "Terra",
                        str(p.get("ACQ_TIME", "")).replace(":", "").zfill(4),
                        numeric(p.get("CONFIDENCE")),
                        numeric(p.get("FRP")),
                        numeric(p.get("BRIGHTNESS")),
                        p.get("DAYNIGHT"),
                        None,
                    ]
                )
        return day, records, source

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = {pool.submit(live_day, date): date for date in live_dates}
        for i, future in enumerate(as_completed(pending), 1):
            date = pending[future]
            try:
                day, records, source = future.result()
                finish(day, records, source)
            except Exception as error:
                failures[str(date)] = str(error)
                print(f"{date}: unavailable: {error}", flush=True)
            if i % 30 == 0 or i == len(pending):
                print(f"Recent Terra days: {i}/{len(pending)}", flush=True)
    # Keep missing days explicit; null groups means unavailable, [] means zero.
    days = [{"date": str(date), "groups": counts.get(str(date))} for date in dates]
    generated = dt.datetime.now(dt.timezone.utc).isoformat()
    save(
        DATA / "detection-counts.json",
        {"satellite": "Terra", "generatedAt": generated, "days": days},
    )
    save(
        DATA / "thermal-manifest.json",
        {
            "start": str(START),
            "end": str(args.end),
            "generatedAt": generated,
            "thermalCoverage": thermal_coverage,
            "sources": sources,
            "unavailable": failures,
            "boundarySources": boundary_sources,
        },
    )
    available_counts = sum(value is not None for value in counts.values())
    print(
        f"Processed {len(dates)} days; thermal counts available for {available_counts}; {len(failures)} download failures. AOD remains live GIBS.",
        flush=True,
    )


if __name__ == "__main__":
    main()
