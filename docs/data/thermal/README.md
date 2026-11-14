Downloaded California MODIS thermal detections

Refresh from the repository root:
uv run scripts/download_data.py

The Python script lives outside docs and uses uv's inline dependency metadata.
It downloads NASA FIRMS annual USA MODIS CSVs for available years from 2020,
then retrieves more recent Terra records from NASA GIBS vector tiles. It also
saves California state and county boundaries from us-atlas (58 counties).
Raw downloads are cached under .cache/modis-downloads (ignored by version control).
Options: --end YYYY-MM-DD --cache-dir /path/to/cache --workers 6

Each daily JSON contains arrays in this order:
longitude, latitude, satellite, acquisition time (HHMM UTC), confidence (0–100),
FRP (MW), brightness temperature (K), day/night flag, inferred hotspot type.
The downloader clips to California's saved state polygon. Annual files contain
Terra and Aqua. Recent GIBS files contain Terra only, with null source type.

Types: 0 presumed vegetation fire; 1 active volcano; 2 other static land source;
3 offshore. These are inferred categories, not confirmed causes. GIBS does not
supply type, so recent records display as Unknown type.

thermal-manifest.json records the download time, exact source URL for each date,
and any unavailable dates. detection-counts.json contains Terra counts grouped
by type and confidence, derived from the same clipped daily records. Null groups
mean unavailable; empty groups mean a successfully downloaded day with zero
California detections. Newly generated current-day records can be partial.

The website fetches daily points, counts, and boundaries only from these static
files. It does not fall back to an external detection API. AOD imagery and its
palette are a separate live GIBS source, decoded approximately as before.
Rerun the downloader to refresh the saved data. The calendar extends to today;
dates newer than the downloaded snapshot are labeled unavailable.

Sources:
https://firms.modaps.eosdis.nasa.gov/country/
https://gibs.earthdata.nasa.gov/vector-metadata/v1.0/FIRMS_MODIS_Thermal_Anomalies.json
https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json
https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json
