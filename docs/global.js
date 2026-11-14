// MODIS data access for the California thermal-anomaly / aerosol visualization.
// Importing this module makes no requests. All dates are UTC calendar dates.

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
  }
  return cache.get(key);
}

async function request(url, signal) {
  const timeout = AbortSignal.timeout(45000);
  const response = await fetch(url, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
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
  return cached("california", async () =>
    (await request(new URL("data/california.json", import.meta.url))).json(),
  );
}
export function loadCounties() {
  return cached("counties", async () =>
    (
      await request(new URL("data/california-counties.json", import.meta.url))
    ).json(),
  );
}
export function loadManifest() {
  return cached("thermal-manifest", async () =>
    (
      await request(new URL("data/thermal-manifest.json", import.meta.url))
    ).json(),
  );
}

// Detections are downloaded by scripts/download_data.py. No browser API fallback.
async function loadFires(date, satellite, signal) {
  const manifest = await loadManifest();
  if (
    satellite === "Terra" &&
    manifest.thermalCoverage &&
    !manifest.thermalCoverage.some(
      ([start, end]) => date >= start && date <= end,
    )
  ) {
    return { records: null, source: null };
  }
  const source = manifest.sources[date];
  if (!source)
    throw new Error(
      "Downloaded detections unavailable for this date; rerun scripts/download_data.py to refresh.",
    );
  if (satellite !== "Terra" && source.includes("gibs.earthdata"))
    throw new Error("Recent downloaded detections are Terra only.");
  const url = new URL(`data/thermal/${date}.json`, import.meta.url).href;
  const rows = await (await request(url, signal)).json();
  const records = rows
    .filter((row) => row[2] === satellite)
    .map((row, index) => ({
      id: `${date}/${satellite}/${index}`,
      date,
      satellite,
      longitude: row[0],
      latitude: row[1],
      acquisitionTime: `${row[3].slice(0, 2)}:${row[3].slice(2)}`,
      confidence: row[4],
      frp: row[5],
      brightness: row[6],
      dayNight: row[7],
      type: row[8],
    }));
  return { records, source };
}

export function loadAODGrid() {
  return cached("aod-grid", async () => {
    const grid = await (
      await request(new URL("data/aod-grid.json", import.meta.url))
    ).json();
    const [west, south, east, north] = grid.bounds;
    grid.cells = grid.indices.map((index) => {
      const longitude =
        west + (((index % grid.width) + 0.5) / grid.width) * (east - west);
      const latitude =
        north -
        ((Math.floor(index / grid.width) + 0.5) / grid.height) *
          (north - south);
      return {
        index,
        longitude,
        latitude,
        weight: Math.cos((latitude * Math.PI) / 180),
      };
    });
    grid.totalWeight = grid.cells.reduce((sum, cell) => sum + cell.weight, 0);
    return grid;
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

async function loadAOD(date, satellite, signal) {
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
  const [palette, grid, response] = await Promise.all([
    loadPalette(),
    loadAODGrid(),
    request(url, signal),
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
  let observedWeight = 0,
    weightedSum = 0;
  const cells = grid.cells.map((cell) => {
    const offset = cell.index * 4;
    const range =
      rgba[offset + 3] === 255
        ? palette.get(`${rgba[offset]},${rgba[offset + 1]},${rgba[offset + 2]}`)
        : null;
    const value = range ? (range.lower + range.upper) / 2 : null;
    if (value !== null) {
      observedWeight += cell.weight;
      weightedSum += value * cell.weight;
    }
    return {
      ...cell,
      value,
      lower: range?.lower ?? null,
      upper: range?.upper ?? null,
    };
  });
  const coverage = grid.totalWeight ? observedWeight / grid.totalWeight : 0;
  return {
    cells,
    coverage,
    mean: coverage >= 0.05 ? weightedSum / observedWeight : null,
    width,
    height,
    source: url,
  };
}

// Bound complete decoded days separately from permanent metadata. Pending requests
// are deduplicated. A failed/partial day is retryable and is never a warm hit.
export const DAY_CACHE_LIMIT = 16;
const dayCache = new Map();
let warmGeneration = 0;
const keyFor = (date, satellite) => satellite + "/" + date;
function touch(key, entry) {
  dayCache.delete(key);
  dayCache.set(key, entry);
}
export function getCachedDay(date, satellite = "Terra") {
  const key = keyFor(date, satellite),
    entry = dayCache.get(key);
  if (!entry?.value) return null;
  touch(key, entry);
  return entry.value;
}
export function getCacheInfo() {
  return {
    limit: DAY_CACHE_LIMIT,
    size: dayCache.size,
    ready: [...dayCache.values()].filter((entry) => entry.value).length,
    pending: [...dayCache.values()].filter((entry) => !entry.value).length,
  };
}
export function stopPrefetch(exceptDate, satellite = "Terra") {
  warmGeneration++;
  const exceptKey = keyFor(exceptDate, satellite);
  for (const [key, entry] of dayCache) {
    if (entry.background && !entry.value && key !== exceptKey) {
      entry.controller.abort();
      dayCache.delete(key);
    }
  }
}
async function readDay(date, satellite, background = false) {
  const key = keyFor(date, satellite);
  if (dayCache.has(key)) {
    const entry = dayCache.get(key);
    if (!background) entry.background = false;
    touch(key, entry);
    return entry.promise;
  }
  while (dayCache.size >= DAY_CACHE_LIMIT) {
    const [oldKey, oldEntry] = dayCache.entries().next().value;
    oldEntry.controller.abort();
    dayCache.delete(oldKey);
  }
  const entry = {
    controller: new AbortController(),
    background,
    value: null,
    promise: null,
  };
  entry.promise = (async () => {
    const [fires, aod] = await Promise.allSettled([
      loadFires(date, satellite, entry.controller.signal),
      loadAOD(date, satellite, entry.controller.signal),
    ]);
    if (entry.controller.signal.aborted)
      throw new DOMException("Aborted", "AbortError");
    const day = {
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
          .map(([layer, result]) => [layer, result.reason.message]),
      ),
    };
    if (!Object.keys(day.errors).length) entry.value = day;
    else if (dayCache.get(key) === entry) dayCache.delete(key);
    return day;
  })().catch((error) => {
    if (dayCache.get(key) === entry) dayCache.delete(key);
    throw error;
  });
  dayCache.set(key, entry);
  return entry.promise;
}
export async function prefetchDays(center, satellite = "Terra") {
  const generation = ++warmGeneration;
  const manifest = await loadManifest();
  if (generation !== warmGeneration) return;
  const centerTime = timestamp(center);
  const desired = [center];
  const available = Object.keys(manifest.sources)
    .filter((date) => date !== center)
    .map((date) => ({ date, distance: Math.abs(timestamp(date) - centerTime) }))
    .sort((a, b) => a.distance - b.distance || b.date.localeCompare(a.date));
  desired.push(
    ...available.slice(0, DAY_CACHE_LIMIT - 1).map((item) => item.date),
  );
  const keys = new Set(desired.map((date) => keyFor(date, satellite)));
  // Retarget the warm window after a date jump; never evict the selected day.
  for (const [key, entry] of dayCache) {
    if (!keys.has(key) && (entry.value || entry.background)) {
      entry.controller.abort();
      dayCache.delete(key);
    }
  }
  for (const date of desired) {
    if (generation !== warmGeneration) return;
    const existing = dayCache.get(keyFor(date, satellite));
    if (existing?.value) continue;
    if (dayCache.size >= DAY_CACHE_LIMIT && !existing) return;
    try {
      await readDay(date, satellite, true);
    } catch {
      /* missing neighbors remain retryable */
    }
    // Yield between neighbors so drawing/input always runs before another request.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Complete decoded days are held in a bounded memory cache. Static detections
 * and boundaries are local files; only AOD imagery/palette uses live GIBS.
 * Missing values remain null; AOD values are approximate palette-bin midpoints.
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
  stopPrefetch(start, satellite);
  const california = await loadCalifornia();
  const days = [];
  for (const date of dates) {
    days.push(await readDay(date, satellite));
    onProgress({ completed: days.length, total: dates.length, date });
  }
  return { start, end, satellite, california, days };
}
