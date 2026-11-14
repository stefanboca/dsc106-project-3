// MODIS data access for the California thermal-anomaly / aerosol visualization.
// No requests run until loadMODIS() is called. All dates are UTC calendar dates.
import { geoContains } from "https://cdn.jsdelivr.net/npm/d3-geo@3/+esm";

const GIBS = "https://gibs.earthdata.nasa.gov";
export const CALIFORNIA_BOUNDS = Object.freeze([-125, 32, -114, 42.2]);
export const DEFAULT_PERIOD = Object.freeze({
  start: "2020-09-02",
  end: "2020-09-16",
  satellite: "Terra",
});
const cache = new Map();

// Cache successful responses; failed requests can be retried. Limit memory use.
function cached(key, read) {
  if (!cache.has(key)) {
    const pending = Promise.resolve()
      .then(read)
      .catch((error) => {
        if (cache.get(key) === pending) cache.delete(key);
        throw error;
      });
    cache.set(key, pending);
    if (cache.size > 100) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return response;
}

function timestamp(date) {
  const value = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(value) ||
    new Date(value).toISOString().slice(0, 10) !== date
  ) {
    throw new Error(`Invalid date: ${date}; expected YYYY-MM-DD`);
  }
  return value;
}

export function datesBetween(start, end) {
  const first = timestamp(start),
    last = timestamp(end);
  if (last < first || last - first > 30 * 86400000)
    throw new Error("Choose an ordered period of at most 31 days.");
  return Array.from({ length: (last - first) / 86400000 + 1 }, (_, i) =>
    new Date(first + i * 86400000).toISOString().slice(0, 10),
  );
}

function number(value) {
  return value == null ||
    String(value).trim() === "" ||
    !Number.isFinite(Number(value))
    ? null
    : Number(value);
}

export function loadCalifornia() {
  return cached('california', async () => (await request(new URL('data/california.json', import.meta.url))).json());
}
export function loadCounties() {
  return cached('counties', async () => (await request(new URL('data/california-counties.json', import.meta.url))).json());
}
export function loadManifest() {
  return cached('thermal-manifest', async () => (await request(new URL('data/thermal-manifest.json', import.meta.url))).json());
}

// Detections are downloaded by scripts/download_data.py. No browser API fallback.
async function loadFires(date, satellite) {
  const manifest = await loadManifest();
  const source = manifest.sources[date];
  if (!source) throw new Error('Downloaded detections unavailable for this date; rerun scripts/download_data.py to refresh.');
  if (satellite !== 'Terra' && source.includes('gibs.earthdata')) throw new Error('Recent downloaded detections are Terra only.');
  const url = new URL(`data/thermal/${date}.json`, import.meta.url).href;
  return cached(`${url}/${satellite}`, async () => {
    const rows = await (await request(url)).json();
    // Records were already clipped to California by the downloader, using the
    // same saved records to build daily counts. Do not apply a different mask.
    const records = rows.filter(row => row[2] === satellite).map((row, index) => ({
      id: `${date}/${satellite}/${index}`, date, satellite,
      longitude: row[0], latitude: row[1],
      acquisitionTime: `${row[3].slice(0, 2)}:${row[3].slice(2)}`,
      confidence: row[4], frp: row[5], brightness: row[6], dayNight: row[7], type: row[8],
    }));
    return { records, source };
  });
}

async function loadPalette() {
  return cached("aod-palette", async () => {
    const url = `${GIBS}/colormaps/v1.3/MODIS_VIIRS_AOD.xml`;
    const xml = new DOMParser().parseFromString(
      await (await request(url)).text(),
      "application/xml",
    );
    if (xml.querySelector("parsererror"))
      throw new Error("Invalid AOD palette XML");
    const colors = new Map();
    for (const entry of xml.querySelectorAll("ColorMapEntry")) {
      if (
        entry.getAttribute("transparent") === "true" ||
        entry.getAttribute("nodata") === "true"
      )
        continue;
      const range = entry
        .getAttribute("value")
        ?.match(/^\[([^,]+),([^\])]+)[\])]$/);
      if (!range) continue;
      const lower = Number(range[1]),
        upper = Number(range[2]);
      if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0)
        continue;
      const key = entry.getAttribute("rgb");
      const previous = colors.get(key);
      colors.set(key, {
        lower: Math.min(lower, previous?.lower ?? lower),
        upper: Math.max(upper, previous?.upper ?? upper),
      });
    }
    if (!colors.size) throw new Error("No usable AOD palette entries");
    return colors;
  });
}

async function loadAOD(date, satellite, california) {
  const width = 240,
    height = 223;
  const parameters = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    LAYERS: `MODIS_${satellite}_Aerosol_Optical_Depth_3km`,
    STYLES: "",
    SRS: "EPSG:4326",
    BBOX: CALIFORNIA_BOUNDS.join(","),
    WIDTH: width,
    HEIGHT: height,
    FORMAT: "image/png",
    TRANSPARENT: "TRUE",
    TIME: date,
  });
  const url = `${GIBS}/wms/epsg4326/best/wms.cgi?${parameters}`;
  return cached(url, async () => {
    const [palette, response] = await Promise.all([
      loadPalette(),
      request(url),
    ]);
    const bitmap = await createImageBitmap(await response.blob(), {
      colorSpaceConversion: "none",
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = context.getImageData(0, 0, width, height).data;
    const cells = [];
    let totalWeight = 0,
      observedWeight = 0,
      weightedSum = 0;
    for (let y = 0; y < height; y++) {
      const latitude = 42.2 - ((y + 0.5) / height) * 10.2;
      for (let x = 0; x < width; x++) {
        const longitude = -125 + ((x + 0.5) / width) * 11;
        if (!geoContains(california, [longitude, latitude])) continue;
        const weight = Math.cos((latitude * Math.PI) / 180),
          offset = (y * width + x) * 4;
        totalWeight += weight;
        const range =
          rgba[offset + 3] === 255
            ? palette.get(
                `${rgba[offset]},${rgba[offset + 1]},${rgba[offset + 2]}`,
              )
            : null;
        const value = range ? (range.lower + range.upper) / 2 : null;
        cells.push({
          longitude,
          latitude,
          value,
          lower: range?.lower ?? null,
          upper: range?.upper ?? null,
          weight,
        });
        if (value !== null) {
          observedWeight += weight;
          weightedSum += value * weight;
        }
      }
    }
    const coverage = totalWeight ? observedWeight / totalWeight : 0;
    return {
      cells,
      coverage,
      mean: coverage >= 0.05 ? weightedSum / observedWeight : null,
      width,
      height,
      source: url,
    };
  });
}

/**
 * Example: const data = await loadMODIS({ start: '2020-09-06', end: '2020-09-12' });
 * data.days: [{date, fires, aod, errors}]; data.california: GeoJSON Feature.
 * fires is null on failure, [] on a successful response with no detections.
 * AOD cells are approximate palette-bin midpoints, NOT original scientific grids.
 * coverage is the observed fraction of California display-pixel area (0–1).
 * FRP is MW per detection; brightness is K; confidence is 0–100. Records are
 * satellite detections, not distinct fires. Missing values remain null.
 */
export async function loadMODIS({
  start = DEFAULT_PERIOD.start,
  end = DEFAULT_PERIOD.end,
  satellite = DEFAULT_PERIOD.satellite,
  onProgress = () => {},
} = {}) {
  if (!["Terra", "Aqua"].includes(satellite))
    throw new Error("Satellite must be Terra or Aqua.");
  const dates = datesBetween(start, end);
  const california = await loadCalifornia();
  const days = new Array(dates.length);
  let cursor = 0,
    completed = 0;
  // Two workers, each making at most two data requests concurrently.
  await Promise.all(
    Array.from({ length: Math.min(2, dates.length) }, async () => {
      while (cursor < dates.length) {
        const index = cursor++,
          date = dates[index];
        const [fires, aod] = await Promise.allSettled([
          loadFires(date, satellite, california),
          loadAOD(date, satellite, california),
        ]);
        days[index] = {
          date,
          fires: fires.status === "fulfilled" ? fires.value.records : null,
          aod: aod.status === "fulfilled" ? aod.value : null,
          fireSource: fires.status === "fulfilled" ? fires.value.source : null,
          errors: Object.fromEntries(
            [
              ["fires", fires],
              ["aod", aod],
            ]
              .filter(([, result]) => result.status === "rejected")
              .map(([key, result]) => [key, result.reason.message]),
          ),
        };
        onProgress({ completed: ++completed, total: dates.length, date });
      }
    }),
  );
  return {
    start,
    end,
    satellite,
    california,
    days,
  };
}
