import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ChartJSNodeCanvas } from 'chartjs-node-canvas';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TEMP_CSV_PATH = __dirname + 'data/water-temp.csv';

/**
 * Bala Bay Daily Water Level Notification
 *
 * Fetches the latest water level from Environment Canada's OGC API
 * and water temperature from NOAA MUR SST satellite data,
 * compares levels to the 5-year July average, and sends a formatted
 * email via Resend.
 *
 * Data sources:
 *   MSC GeoMet OGC API (api.weather.gc.ca) — water levels
 *   NOAA ERDDAP MUR SST (polarwatch.noaa.gov) — water temperature
 * Station: 02EB015 — Bala Bay at Bala (Lake Muskoka)
 */

const STATION = '02EB015';
const API_BASE = 'https://api.weather.gc.ca/collections';

// Time windows derived at run time.
const TODAY_ISO = new Date().toISOString().substring(0, 10);
const CURRENT_YEAR = parseInt(TODAY_ISO.substring(0, 4));
// Annual low-water search: from Jan 1 of the current year through today.
const LOW_WATER_START = `${CURRENT_YEAR}-01-01`;
const LOW_WATER_END = TODAY_ISO;
// Daily-mean history fetched per station (used for July average, low water,
// and chart backfill).
const HISTORY_START = `${CURRENT_YEAR - 5}-01-01`;
const HISTORY_END = TODAY_ISO;

// Additional stations to show current water levels
const EXTRA_STATIONS = [
  { id: '02EB018', name: 'Beaumaris', label: 'Lake Muskoka' },
  { id: '02EB020', name: 'Port Carling', label: 'Lake Rosseau' },
  { id: '02EB004', name: 'Port Sydney', label: 'N. Branch Muskoka R.' },
  { id: '02EB008', name: 'Baysville', label: 'S. Branch Muskoka R.' },
];

// Historical high water marks (metres) — station ID → { level, year }
const HIGH_WATER_MARKS = {
  '02EB015': { level: 226.051, year: 2019 },
  '02EB018': { level: 10.461, year: 2019 },
  '02EB020': { level: 9.35, year: 2013 },
};

// Flow rate stations (discharge in m³/s) — WSC gauges on the rivers
const FLOW_STATIONS = [
  { id: '02EB006', name: 'Bala', label: 'Muskoka River' },
  { id: '02EB013', name: 'Bracebridge', label: 'Muskoka River' },
  { id: '02EB004', name: 'Port Sydney', label: 'N. Branch Muskoka R.' },
  { id: '02EB008', name: 'Baysville', label: 'S. Branch Muskoka R.' },
  { id: '02EB011', name: 'Port Carling', label: 'Indian River' },
];

// Bala Bay coordinates for satellite SST lookup
const BALA_LAT = 45.01;
const BALA_LON = -79.6;
const ERDDAP_MIRRORS = [
  'https://polarwatch.noaa.gov/erddap/griddap',   // sometimes 404s while its copy reloads
  'https://spraydata.ucsd.edu/erddap/griddap',    // Scripps
  'https://erddap.marine.usf.edu/erddap/griddap', // USF
  // PFEG origin servers last: their blacklist covers GitHub runner IPs when
  // active, but they always work from residential IPs (--fetch-only)
  'https://coastwatch.pfeg.noaa.gov/erddap/griddap',
  'https://upwell.pfeg.noaa.gov/erddap/griddap',
];
// NCEI hosts the GHRSST MUR archive as one netCDF file per day with OPeNDAP
// subsetting — separate infrastructure from the blacklisted PFEG cluster.
// No range queries, so it's a fallback for single days and small gaps only.
const NCEI_THREDDS_BASE = 'https://www.ncei.noaa.gov/thredds-ocean';
const NCEI_MUR_PATH = 'ghrsst/L4/GLOB/JPL/MUR';
// MUR grid: lat -89.99..89.99, lon -179.99..179.99, both step 0.01
const MUR_LAT_IDX = Math.round((BALA_LAT + 89.99) / 0.01);  // 13500
const MUR_LON_IDX = Math.round((BALA_LON + 179.99) / 0.01); // 10039
const NCEI_MAX_GAP_DAYS = 30; // largest gap worth filling one day at a time

// ── Tunable constants ──
const CM_PER_INCH = 2.54;
const CHART_DAYS = 90;  // trailing calendar-day window for level/flow charts
const CHART_HEIGHT_PX = 120;
const CHART_MIN_BAR_PX = 3;
const CHART_MIN_RANGE = 0.01;
const ERDDAP_TIMEOUT_MS = 20000;
const ERDDAP_DEADLINE_MS = 6 * 60 * 1000; // total time budget for historical backfill
const BACKFILL_START = '2002-06-01';      // MUR SST v4.1 starts here — earliest available
const BACKFILL_CHUNK_DAYS = 200;          // ERDDAP reads one file per day server-side; keep queries small
const BACKFILL_MAX_CHUNKS = 6;            // per run; cache catches up across daily runs
const OGC_TIMEOUT_MS = 15000;
const OUTLIER_THRESHOLD_M = 0.5;

// ── Configuration (from environment variables) ──
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = (process.env.EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);
const EMAIL_FROM = process.env.EMAIL_FROM || 'Bala Bay <onboarding@resend.dev>';

// ── Fetch helpers ──

async function fetchJSON(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(OGC_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

async function fetchAllFeatures(buildUrl, maxPages = 20) {
  const size = 500;
  let all = [];
  for (let p = 0; p < maxPages; p++) {
    const url = buildUrl(size, p * size);
    const data = await fetchJSON(url);
    const feats = data.features || [];
    all = all.concat(feats);
    if (feats.length < size) break;
  }
  return all;
}

// ── Parsers ──

function parseRealtime(features, field) {
  const dayMap = {};
  for (const f of features) {
    const p = f.properties || {};
    if (p[field] == null) continue;
    const d = (p.DATETIME || '').substring(0, 10);
    if (!d) continue;
    if (!dayMap[d]) dayMap[d] = [];
    dayMap[d].push(p[field]);
  }
  return Object.entries(dayMap)
    .map(([date, v]) => ({ date, value: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseDaily(features, field) {
  const results = [];
  for (const f of features) {
    const p = f.properties || {};
    if (p[field] == null) continue;
    const date = (p.DATE || '').substring(0, 10);
    if (date) results.push({ date, value: p[field] });
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Outlier filter ──

function filterOutliers(data) {
  if (data.length < 4) return data;
  const clean = [data[0]];
  for (let i = 1; i < data.length - 1; i++) {
    const avg = (data[i - 1].value + data[i + 1].value) / 2;
    if (Math.abs(data[i].value - avg) > OUTLIER_THRESHOLD_M) {
      console.log(`  Outlier removed: ${data[i].date} = ${data[i].value}m`);
      continue;
    }
    clean.push(data[i]);
  }
  clean.push(data[data.length - 1]);
  return clean;
}

// ── Water temperature (NOAA MUR SST satellite data) ──

async function fetchWaterTemp() {
  // MUR SST: 0.01° resolution global SST analysis, updated daily
  // Uses "(last)" to get most recent available data point — tries each mirror in order
  for (const mirror of ERDDAP_MIRRORS) {
    const { hostname } = new URL(mirror);
    const url = `${mirror}/jplMURSST41.json?analysed_sst[(last)][(${BALA_LAT})][(${BALA_LON})]`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS) });
      if (!resp.ok) {
        // resp.url is the final URL after redirects — ERDDAP mirrors of PFEG
        // datasets redirect data requests back to the origin server
        console.log(`  Water temp HTTP ${resp.status} from ${hostname} (final URL: ${resp.url})`);
        continue;
      }
      const data = await resp.json();
      const rows = data?.table?.rows;
      if (!rows || rows.length === 0) {
        console.log(`  Water temp: empty response from ${hostname}`);
        continue;
      }
      // Row format: [time, latitude, longitude, analysed_sst]
      const sst = rows[0][3];
      if (sst == null) {
        console.log(`  Water temp: null SST (land-masked?) from ${hostname}`);
        continue;
      }
      const time = rows[0][0];
      const date = time ? time.substring(0, 10) : null;
      return { tempC: Math.round(sst * 10) / 10, date };
    } catch (e) {
      console.log(`  Water temp fetch failed (${hostname}): ${e.message}`);
    }
  }

  // Fallback: NCEI THREDDS archive, probing backwards from the most recent
  // plausible day (MUR lags ~2 days; the NCEI archive a little more)
  console.log('  All ERDDAP mirrors failed — falling back to NCEI THREDDS...');
  for (let back = 2; back <= 8; back++) {
    const result = await fetchMurPointNCEI(addDays(TODAY_ISO, -back));
    if (result) return result;
  }
  return null;
}

// ── NCEI THREDDS fallback: per-day GHRSST MUR granules via OPeNDAP ──

function parseMurAscii(text) {
  // DAP2 .ascii grid output: the data line looks like "[0][13500], 288.123"
  const m = text.match(/^\[\d+\](?:\[\d+\])*,\s*(-?\d+(?:\.\d+)?)/m);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  // The granule stores analysed_sst as a packed short (scale 0.001, offset
  // 298.15 K); some TDS configs unpack to Kelvin or Celsius floats. Packed
  // shorts print as integers, floats with a decimal point. Range-check last
  // (also rejects the -32768 fill value).
  if (!m[1].includes('.')) v = v * 0.001 + 298.15 - 273.15;
  else if (v > 200 && v < 320) v = v - 273.15;
  if (v < -5 || v > 45) return null;
  return v;
}

async function fetchMurPointNCEI(dateStr) {
  const year = dateStr.substring(0, 4);
  const doy = String(toRecord(dateStr, 0).dayOfYear).padStart(3, '0');
  const dir = `${NCEI_MUR_PATH}/${year}/${doy}`;
  try {
    // Granule filenames vary across GDS versions — list the day's catalog
    // instead of guessing
    const catResp = await fetch(`${NCEI_THREDDS_BASE}/catalog/${dir}/catalog.xml`, {
      signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS),
    });
    if (!catResp.ok) {
      console.log(`  NCEI catalog HTTP ${catResp.status} for ${dateStr}`);
      return null;
    }
    const fileMatch = (await catResp.text()).match(/name="([^"]*MUR[^"]*\.nc)"/i);
    if (!fileMatch) {
      console.log(`  NCEI: no MUR granule listed for ${dateStr}`);
      return null;
    }
    const url = `${NCEI_THREDDS_BASE}/dodsC/${dir}/${fileMatch[1]}.ascii?analysed_sst[0][${MUR_LAT_IDX}][${MUR_LON_IDX}]`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS) });
    if (!resp.ok) {
      console.log(`  NCEI OPeNDAP HTTP ${resp.status} for ${dateStr}`);
      return null;
    }
    const tempC = parseMurAscii(await resp.text());
    if (tempC === null) {
      console.log(`  NCEI: could not parse SST for ${dateStr}`);
      return null;
    }
    console.log(`  NCEI THREDDS: ${dateStr} = ${tempC.toFixed(1)}°C`);
    return { tempC: Math.round(tempC * 10) / 10, date: dateStr };
  } catch (e) {
    console.log(`  NCEI fetch failed for ${dateStr}: ${e.message}`);
    return null;
  }
}

// ── Historical water temperature for spaghetti chart (MUR SST v4.1 starts 2002-06-01) ──

function toRecord(dateStr, tempC) {
  const year = parseInt(dateStr.substring(0, 4));
  const dt = new Date(dateStr + 'T00:00:00Z');
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const dayOfYear = Math.floor((dt - jan1) / 86400000) + 1;
  return { date: dateStr, year, dayOfYear, tempC };
}

async function loadCachedTemp() {
  try {
    const csv = await fs.readFile(TEMP_CSV_PATH, 'utf8');
    const lines = csv.trim().split('\n').slice(1); // skip header
    const records = [];
    for (const line of lines) {
      const [date, temp] = line.split(',');
      const tempC = parseFloat(temp);
      if (date && !isNaN(tempC)) records.push(toRecord(date, tempC));
    }
    return records;
  } catch {
    return [];
  }
}

async function saveTempCache(records) {
  await fs.mkdir(__dirname + 'data', { recursive: true });
  const rows = records.map(r => `${r.date},${r.tempC}`);
  await fs.writeFile(TEMP_CSV_PATH, 'date,tempC\n' + rows.join('\n') + '\n', 'utf8');
}

// ── Daily level/flow observation cache ──
// The realtime API only keeps ~1 month and daily means lag months behind, so
// observed daily values are cached in the repo (like the temp cache) to let
// the charts show a full trailing window.

const LEVEL_CACHE_PATH = __dirname + 'data/level-history.json';

let levelCachePromise = null;
function getLevelCache() {
  if (!levelCachePromise) {
    levelCachePromise = fs.readFile(LEVEL_CACHE_PATH, 'utf8')
      .then(JSON.parse)
      .catch(() => ({}));
  }
  return levelCachePromise;
}

async function saveLevelCache() {
  const cache = await getLevelCache();
  await fs.mkdir(__dirname + 'data', { recursive: true });
  await fs.writeFile(LEVEL_CACHE_PATH, JSON.stringify(cache, null, 1), 'utf8');
}

// Merge freshly observed daily values into the cache under `key` and return
// the combined series. Fresh values win; only the last ~400 days are kept.
function mergeWithLevelCache(cache, key, days) {
  const entry = cache[key] || {};
  for (const d of days) entry[d.date] = Math.round(d.value * 10000) / 10000;
  const keep = Object.keys(entry).sort().slice(-400);
  cache[key] = Object.fromEntries(keep.map(k => [k, entry[k]]));
  return keep.map(date => ({ date, value: cache[key][date] }));
}

function parseERDDAPCsv(text) {
  const lines = text.split('\n');
  // Line 1: header, Line 2: units, Lines 3+: data
  const dataLines = lines.slice(2).filter(l => l.trim());
  const records = [];
  for (const line of dataLines) {
    const parts = line.split(',');
    if (parts.length < 4) continue;
    const dateStr = parts[0].substring(0, 10);
    const sst = parseFloat(parts[3]);
    if (!isNaN(sst)) records.push(toRecord(dateStr, sst));
  }
  return records;
}

// Fetch one date range from ERDDAP, trying CSV then JSON across all mirrors.
// Returns records[] on success, null if every attempt failed or the deadline passed.
async function fetchTempChunk(startDate, endDate, deadlineAt) {
  const startTs = `${startDate}T09:00:00Z`;
  const endTs = `${endDate}T09:00:00Z`;
  for (const format of ['csv', 'json']) {
    for (const mirror of ERDDAP_MIRRORS) {
      if (Date.now() > deadlineAt) {
        console.log('  ERDDAP time budget exhausted');
        return null;
      }
      const { hostname } = new URL(mirror);
      const url = `${mirror}/jplMURSST41.${format}?analysed_sst[(${startTs}):(${endTs})][(${BALA_LAT})][(${BALA_LON})]`;
      console.log(`  Trying ERDDAP ${format.toUpperCase()}: ${startDate} to ${endDate} via ${hostname} (${ERDDAP_TIMEOUT_MS / 1000}s timeout)...`);
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(ERDDAP_TIMEOUT_MS) });
        if (!resp.ok) {
          const errBody = await resp.text().catch(() => '');
          console.log(`  ERDDAP HTTP ${resp.status} (final URL: ${resp.url}): ${errBody.substring(0, 200)}`);
          continue;
        }
        let records;
        if (format === 'csv') {
          records = parseERDDAPCsv(await resp.text());
        } else {
          const rows = (await resp.json())?.table?.rows || [];
          records = [];
          for (const row of rows) {
            const dateStr = row[0]?.substring(0, 10);
            const sst = row[3];
            if (dateStr && sst != null && !isNaN(sst)) {
              records.push(toRecord(dateStr, Math.round(sst * 10) / 10));
            }
          }
        }
        if (records.length > 0) {
          console.log(`  ERDDAP returned ${records.length} records via ${hostname}`);
          return records;
        }
        console.log(`  ERDDAP returned no records via ${hostname}`);
      } catch (e) {
        console.log(`  ERDDAP ${format.toUpperCase()} failed (${hostname}): ${e.message}`);
      }
    }
  }
  return null;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().substring(0, 10);
}

async function fetchHistoricalWaterTemp() {
  const cached = await loadCachedTemp();
  const latestCached = cached.length > 0 ? cached[cached.length - 1].date : null;

  // MUR SST data lags ~2 days behind real-time
  const endDate = addDays(TODAY_ISO, -3);

  // --fetch-only runs (seeding from an unblocked IP) get a much bigger budget
  const fetchOnly = process.argv.includes('--fetch-only');
  const maxChunks = fetchOnly ? 60 : BACKFILL_MAX_CHUNKS;
  const deadlineAt = Date.now() + (fetchOnly ? 5 : 1) * ERDDAP_DEADLINE_MS;

  const byDate = new Map(cached.map(r => [r.date, r]));
  let all = cached;
  let fetchedAny = false;
  let chunksUsed = 0;

  const save = async () => {
    all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    await saveTempCache(all);
    fetchedAny = true;
  };

  // 1. Tail: extend forward from the newest cached day (oldest chunk first)
  let startDate = latestCached ? addDays(latestCached, 1) : BACKFILL_START;
  while (startDate <= endDate && chunksUsed < maxChunks && Date.now() < deadlineAt) {
    let chunkEnd = addDays(startDate, BACKFILL_CHUNK_DAYS - 1);
    if (chunkEnd > endDate) chunkEnd = endDate;
    chunksUsed++;
    const records = await fetchTempChunk(startDate, chunkEnd, deadlineAt);
    if (!records) {
      // ERDDAP failed entirely — inch forward via NCEI, one day at a time,
      // starting at the gap's oldest day so the cache stays contiguous.
      // Guarantees recent years keep filling in even if ERDDAP is down for weeks.
      let nceiEnd = addDays(startDate, NCEI_MAX_GAP_DAYS - 1);
      if (nceiEnd > endDate) nceiEnd = endDate;
      console.log(`  ERDDAP down — filling ${startDate}..${nceiEnd} from NCEI THREDDS...`);
      for (let d = startDate; d <= nceiEnd && Date.now() < deadlineAt; d = addDays(d, 1)) {
        const point = await fetchMurPointNCEI(d);
        if (!point) break; // stop at the first hole to stay contiguous
        byDate.set(point.date, toRecord(point.date, point.tempC));
        await new Promise(r => setTimeout(r, 100));
      }
      if (byDate.size > cached.length) await save();
      break; // stop so the cache never develops interior gaps
    }
    for (const r of records) byDate.set(r.date, r);
    await save();
    startDate = addDays(chunkEnd, 1);
  }

  // 2. Head: extend backward from the oldest cached day toward BACKFILL_START,
  //    newest chunk first so the cached block always stays contiguous. Only
  //    runs once the tail is fully caught up — recent years matter more than
  //    old ones, and a flaky tail chunk must not divert the budget backwards.
  const tailComplete = startDate > endDate;
  let earliest = all.length > 0 ? all[0].date : null;
  while (tailComplete && earliest && earliest > BACKFILL_START && chunksUsed < maxChunks && Date.now() < deadlineAt) {
    const chunkEnd = addDays(earliest, -1);
    let chunkStart = addDays(chunkEnd, -(BACKFILL_CHUNK_DAYS - 1));
    if (chunkStart < BACKFILL_START) chunkStart = BACKFILL_START;
    chunksUsed++;
    const records = await fetchTempChunk(chunkStart, chunkEnd, deadlineAt);
    if (!records) break;
    for (const r of records) byDate.set(r.date, r);
    await save();
    earliest = chunkStart;
  }

  if (!fetchedAny) {
    if (cached.length > 0) {
      console.log(`  Historical temp: cache is current (${cached.length} records)`);
      return cached;
    }
    console.log('  All ERDDAP attempts failed');
    return null;
  }

  console.log(`  Historical temp: ${all.length} records across ${new Set(all.map(r => r.year)).size} years`);
  return all;
}

// ── Build water temperature spaghetti chart (year-over-year overlay) ──

async function buildTempSpaghettiChart(records) {
  if (!records || records.length === 0) return null;

  const byYear = {};
  for (const r of records) {
    if (!byYear[r.year]) byYear[r.year] = [];
    byYear[r.year].push(r);
  }

  const years = Object.keys(byYear).map(Number).sort();
  const currentYear = CURRENT_YEAR;
  const prevYear = currentYear - 1;

  const datasets = years.map(year => {
    const sorted = byYear[year].sort((a, b) => a.dayOfYear - b.dayOfYear);
    // Insert a null point at holes > 5 days so the line breaks (spanGaps is
    // off) instead of drawing a misleading straight jump across the gap
    const data = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i].dayOfYear - sorted[i - 1].dayOfYear > 5) {
        data.push({ x: sorted[i - 1].dayOfYear + 1, y: null });
      }
      data.push({ x: sorted[i].dayOfYear, y: sorted[i].tempC });
    }

    let color, width, order;
    if (year === currentYear) {
      color = '#2D6A9F';
      width = 2.5;
      order = 0;
    } else if (year === prevYear) {
      color = '#C0392B';
      width = 2;
      order = 1;
    } else {
      color = 'rgba(150, 150, 150, 0.55)';
      width = 1;
      order = 2;
    }

    return {
      label: String(year),
      data,
      borderColor: color,
      borderWidth: width,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      spanGaps: false,
      order,
    };
  });

  // Sort so current year renders on top (lowest order = drawn last = on top)
  datasets.sort((a, b) => b.order - a.order);

  const monthStarts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const chartWidth = 560;
  const chartHeight = 280;

  const chartJSNodeCanvas = new ChartJSNodeCanvas({
    width: chartWidth,
    height: chartHeight,
    backgroundColour: '#FFFFFF',
  });

  const config = {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: false,
      animation: false,
      showLine: true,
      scales: {
        x: {
          type: 'linear',
          min: 1,
          max: 366,
          // Chart.js has no "tick values" option for linear axes — replace the
          // auto-generated ticks so one lands on the 1st of every month
          afterBuildTicks: (axis) => {
            axis.ticks = monthStarts.map(value => ({ value }));
          },
          ticks: {
            callback: (val) => {
              const idx = monthStarts.indexOf(val);
              return idx >= 0 ? monthLabels[idx] : '';
            },
            font: { size: 10, family: 'sans-serif' },
            color: '#6B6B6B',
            autoSkip: false,
            maxRotation: 0,
          },
          grid: { color: '#F0EDE8' },
        },
        y: {
          title: {
            display: true,
            text: '°C',
            font: { size: 11, family: 'sans-serif' },
            color: '#6B6B6B',
          },
          ticks: {
            font: { size: 10, family: 'sans-serif' },
            color: '#6B6B6B',
          },
          grid: { color: '#F0EDE8' },
        },
      },
      plugins: {
        title: {
          display: true,
          text: 'Bala Bay Water Temperature — Year over Year',
          font: { size: 13, weight: '600', family: 'sans-serif' },
          color: '#0B1D33',
          padding: { bottom: 8 },
        },
        legend: { display: false },
        tooltip: { enabled: false },
      },
      layout: {
        padding: { left: 4, right: 12, top: 4, bottom: 4 },
      },
    },
  };

  const buffer = await chartJSNodeCanvas.renderToBuffer(config);
  console.log(`  Spaghetti chart: ${buffer.length} bytes PNG`);
  return buffer;
}

// ── Shared chart helpers ──

// Trailing calendar window: data from the last n days, not the last n rows
// (daily-mean history can lag months, leaving holes before the realtime data)
function lastCalendarDays(days, n) {
  const cutoff = addDays(TODAY_ISO, -(n - 1));
  return days.filter(d => d.date >= cutoff);
}

function fmtShort(d) {
  return new Date(d.date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

function buildWaterLevelChart(name, label, days, stJulyAvg, isFirst, stationId) {
  if (!days || days.length === 0) return null;
  const chartDays = lastCalendarDays(days, CHART_DAYS);
  if (chartDays.length === 0) return null;
  const hwm = stationId ? HIGH_WATER_MARKS[stationId] : null;
  const barPx = Math.min(16, Math.max(3, Math.floor(440 / chartDays.length)));

  const latest = chartDays[chartDays.length - 1];
  const vsJulyStr = stJulyAvg !== null
    ? (() => {
        const diffIn = (latest.value - stJulyAvg) * 100 / CM_PER_INCH;
        return ` · ${diffIn >= 0 ? '+' : ''}${diffIn.toFixed(1)}in vs Jul avg`;
      })()
    : '';

  const minVal = Math.min(...chartDays.map(d => d.value), stJulyAvg ?? Infinity, hwm ? hwm.level : Infinity);
  const maxVal = Math.max(...chartDays.map(d => d.value), stJulyAvg ?? -Infinity, hwm ? hwm.level : -Infinity);
  const range = maxVal - minVal || CHART_MIN_RANGE;

  const firstDate = chartDays[0];
  const midDate = chartDays[Math.floor(chartDays.length / 2)];
  const lastDate = chartDays[chartDays.length - 1];

  const bars = chartDays.map((d, i) => {
    const pct = (d.value - minVal) / range;
    const height = Math.max(CHART_MIN_BAR_PX, Math.round(pct * (CHART_HEIGHT_PX - 10) + CHART_MIN_BAR_PX));
    const color = i === chartDays.length - 1 ? '#E07B4C' : '#4A9BD9';
    return `<td style="vertical-align:bottom;padding:0 0.5px;"><div style="width:${barPx}px;height:${height}px;background:${color};border-radius:1px;"></div></td>`;
  }).join('');

  let refLines = '';
  if (stJulyAvg !== null) {
    const refPx = Math.max(1, Math.round(((stJulyAvg - minVal) / range) * (CHART_HEIGHT_PX - 10) + CHART_MIN_BAR_PX));
    refLines += `<div style="margin-top:-${refPx}px;border-top:1px dashed #5BA88A;height:0;margin-bottom:${refPx - 1}px;"></div>`;
  }
  if (hwm) {
    const refPx = Math.max(1, Math.round(((hwm.level - minVal) / range) * (CHART_HEIGHT_PX - 10) + CHART_MIN_BAR_PX));
    refLines += `<div style="margin-top:-${refPx}px;border-top:1px dashed #C0392B;height:0;margin-bottom:${refPx - 1}px;"></div>`;
  }

  const sectionStyle = isFirst
    ? 'margin-top:12px;'
    : 'margin-top:20px;border-top:1px solid #E0DAD2;padding-top:16px;';

  const legendItems = [
    '<span style="display:inline-block;width:8px;height:8px;background:#4A9BD9;border-radius:1px;vertical-align:middle;margin-right:3px;"></span>Daily level',
    '<span style="display:inline-block;width:8px;height:8px;background:#E07B4C;border-radius:1px;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>Today',
  ];
  if (stJulyAvg !== null) {
    legendItems.push('<span style="display:inline-block;width:12px;border-top:1px dashed #5BA88A;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>Jul avg');
  }
  if (hwm) {
    legendItems.push(`<span style="display:inline-block;width:12px;border-top:1px dashed #C0392B;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>${hwm.year} high`);
  }

  const html = `
      <div style="${sectionStyle}">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:2px;">${name} — ${label}</div>
        <div style="font-size:9px;color:#999;margin-bottom:8px;">Water Level — Trailing ${CHART_DAYS} Days${vsJulyStr}</div>
        <div style="display:inline-block;">
          <div style="border-bottom:1px solid #E0DAD2;padding-left:2px;">
            <table style="border-collapse:collapse;height:${CHART_HEIGHT_PX}px;"><tr>${bars}</tr></table>
            ${refLines}
          </div>
          <table style="width:100%;border-collapse:collapse;margin-top:2px;"><tr>
            <td style="font-size:9px;color:#999;text-align:left;padding:0;">${fmtShort(firstDate)}</td>
            <td style="font-size:9px;color:#999;text-align:center;padding:0;">${fmtShort(midDate)}</td>
            <td style="font-size:9px;color:#6B6B6B;text-align:right;font-weight:600;padding:0;">${fmtShort(lastDate)}</td>
          </tr></table>
        </div>
        <div style="margin-top:6px;font-size:9px;color:#999;">${legendItems.join('\n          ')}</div>
      </div>`;

  return { html };
}

function buildSpreadChart(balaDays, balaJulyAvg, beauDays, beauJulyAvg) {
  if (!balaDays || !beauDays || balaJulyAvg === null || beauJulyAvg === null) return null;

  const balaByDate = new Map(balaDays.map(d => [d.date, d.value]));
  const spreadDays = [];
  for (const d of beauDays) {
    const balaVal = balaByDate.get(d.date);
    if (balaVal === undefined) continue;
    const spreadIn = ((d.value - beauJulyAvg) - (balaVal - balaJulyAvg)) * 100 / CM_PER_INCH;
    spreadDays.push({ date: d.date, spread: spreadIn });
  }
  if (spreadDays.length === 0) return null;

  const chartDays = lastCalendarDays(spreadDays, CHART_DAYS);
  if (chartDays.length === 0) return null;
  const latestSpread = chartDays[chartDays.length - 1].spread;
  const barPx = Math.min(16, Math.max(3, Math.floor(440 / chartDays.length)));

  const values = chartDays.map(d => d.spread);
  const minVal = Math.min(...values, 0) - 0.5;
  const maxVal = Math.max(...values, 0) + 0.5;
  const range = maxVal - minVal || CHART_MIN_RANGE;

  const firstDate = chartDays[0];
  const midDate = chartDays[Math.floor(chartDays.length / 2)];
  const lastDate = chartDays[chartDays.length - 1];

  const bars = chartDays.map((d) => {
    const pct = (d.spread - minVal) / range;
    const height = Math.max(CHART_MIN_BAR_PX, Math.round(pct * (CHART_HEIGHT_PX - 10) + CHART_MIN_BAR_PX));
    const color = d.spread >= 0 ? '#4A9BD9' : '#E07B4C';
    return `<td style="vertical-align:bottom;padding:0 0.5px;"><div style="width:${barPx}px;height:${height}px;background:${color};border-radius:1px;"></div></td>`;
  }).join('');

  const zeroPx = Math.max(1, Math.round(((0 - minVal) / range) * (CHART_HEIGHT_PX - 10) + CHART_MIN_BAR_PX));
  const zeroLine = `<div style="margin-top:-${zeroPx}px;border-top:1px solid #666;height:0;margin-bottom:${zeroPx - 1}px;"></div>`;

  const html = `
      <div style="margin-top:20px;border-top:1px solid #E0DAD2;padding-top:16px;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:2px;">Beaumaris vs Bala — Water Level Spread</div>
        <div style="font-size:9px;color:#999;margin-bottom:8px;">Trailing ${CHART_DAYS} Days · Current: ${latestSpread >= 0 ? '+' : ''}${latestSpread.toFixed(1)}in</div>
        <div style="display:inline-block;">
          <div style="border-bottom:1px solid #E0DAD2;padding-left:2px;">
            <table style="border-collapse:collapse;height:${CHART_HEIGHT_PX}px;"><tr>${bars}</tr></table>
            ${zeroLine}
          </div>
          <table style="width:100%;border-collapse:collapse;margin-top:2px;"><tr>
            <td style="font-size:9px;color:#999;text-align:left;padding:0;">${fmtShort(firstDate)}</td>
            <td style="font-size:9px;color:#999;text-align:center;padding:0;">${fmtShort(midDate)}</td>
            <td style="font-size:9px;color:#6B6B6B;text-align:right;font-weight:600;padding:0;">${fmtShort(lastDate)}</td>
          </tr></table>
        </div>
        <div style="margin-top:4px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:8px;height:8px;background:#4A9BD9;border-radius:1px;vertical-align:middle;margin-right:3px;"></span>Beaumaris above Bala
          <span style="display:inline-block;width:8px;height:8px;background:#E07B4C;border-radius:1px;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>Bala above Beaumaris
        </div>
        <div style="font-size:8px;color:#BBB;margin-top:2px;">Normalized to each station’s 5-year July average (inches)</div>
      </div>`;

  return { html };
}

function buildFlowChart(name, label, days, isFirst) {
  if (!days || days.length === 0) return '';
  const chartDays = lastCalendarDays(days, CHART_DAYS);
  if (chartDays.length === 0) return '';
  const barPx = Math.min(16, Math.max(3, Math.floor(440 / chartDays.length)));
  const minVal = Math.min(...chartDays.map(d => d.value));
  const maxVal = Math.max(...chartDays.map(d => d.value));
  const range = maxVal - minVal || CHART_MIN_RANGE;

  const bars = chartDays.map((d, i) => {
    const pct = (d.value - minVal) / range;
    const height = Math.max(CHART_MIN_BAR_PX, Math.round(pct * (CHART_HEIGHT_PX - 10) + CHART_MIN_BAR_PX));
    const color = i === chartDays.length - 1 ? '#E07B4C' : '#6B8EAD';
    return `<td style="vertical-align:bottom;padding:0 0.5px;"><div style="width:${barPx}px;height:${height}px;background:${color};border-radius:1px;" title="${d.date}: ${d.value.toFixed(1)} m³/s"></div></td>`;
  }).join('');

  const firstDate = chartDays[0];
  const midDate = chartDays[Math.floor(chartDays.length / 2)];
  const lastDate = chartDays[chartDays.length - 1];
  const latest = chartDays[chartDays.length - 1];

  const sectionStyle = isFirst
    ? 'margin-top:12px;'
    : 'margin-top:20px;border-top:1px solid #E0DAD2;padding-top:16px;';

  return `
      <div style="${sectionStyle}">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:2px;">${name} — ${label}</div>
        <div style="font-size:9px;color:#999;margin-bottom:8px;">Flow Rate — Trailing ${CHART_DAYS} Days · ${latest.value.toFixed(1)} m³/s</div>
        <div style="display:inline-block;">
          <div style="position:relative;border-bottom:1px solid #E0DAD2;padding-left:2px;">
            <table style="border-collapse:collapse;height:${CHART_HEIGHT_PX}px;"><tr>${bars}</tr></table>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-top:2px;"><tr>
            <td style="font-size:9px;color:#999;text-align:left;padding:0;">${fmtShort(firstDate)}</td>
            <td style="font-size:9px;color:#999;text-align:center;padding:0;">${fmtShort(midDate)}</td>
            <td style="font-size:9px;color:#6B6B6B;text-align:right;font-weight:600;padding:0;">${fmtShort(lastDate)}</td>
          </tr></table>
        </div>
        <div style="margin-top:6px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:8px;height:8px;background:#6B8EAD;border-radius:1px;vertical-align:middle;margin-right:3px;"></span>Daily flow
          <span style="display:inline-block;width:8px;height:8px;background:#E07B4C;border-radius:1px;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>Today
        </div>
      </div>`;
}

function txtRow(name, label, recentDays, stJulyAvg, lowWater) {
  if (!recentDays || recentDays.length === 0) return null;
  const lat = recentDays[recentDays.length - 1];
  const aboveLow = lowWater ? ((lat.value - lowWater.value) * 100 / CM_PER_INCH).toFixed(1) : '?';
  const belowSum = stJulyAvg !== null ? ((lat.value - stJulyAvg) * 100 / CM_PER_INCH).toFixed(1) : '?';
  return `  ${name} (${label}): ${lat.value.toFixed(3)}m | ↑low:${aboveLow}in | ↓summer:${belowSum}in`;
}


// ── Fetch all data for a station: realtime + 5-year daily-mean history, then
//    derive July avg, low water, and a combined daily series used for the
//    chart, day-change metrics, and the CSV attachment. ──

async function fetchStationData(stationId) {
  const result = {
    realtimeDaily: [],
    history: [],
    recentDays: null,
    julyAvg: null,
    lowWater: null,
  };

  // 1. Realtime data (recent ~30 days of sub-daily readings, averaged to daily)
  try {
    const rtFeats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${stationId}&limit=${lim}&offset=${off}`,
      20
    );
    result.realtimeDaily = filterOutliers(parseRealtime(rtFeats, 'LEVEL'));
  } catch (e) {
    console.log(`    Realtime failed: ${e.message}`);
  }

  // 2. Daily-mean history (5+ years). Authoritative daily values; lags realtime
  //    by a few days so we backfill with realtime below for any missing recent dates.
  try {
    const feats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${stationId}&datetime=${HISTORY_START}/${HISTORY_END}&limit=${lim}&offset=${off}`,
      20
    );
    result.history = parseDaily(feats, 'LEVEL');
  } catch (e) {
    console.log(`    Daily-mean history failed: ${e.message}`);
  }

  // 3. Combine history + realtime (realtime fills dates daily-mean hasn't
  //    published yet), then merge with the on-disk cache of past observations.
  const histDates = new Set(result.history.map(d => d.date));
  const rtFill = result.realtimeDaily.filter(d => !histDates.has(d.date));
  const combined = [...result.history, ...rtFill].sort((a, b) => a.date.localeCompare(b.date));
  result.recentDays = mergeWithLevelCache(await getLevelCache(), `level:${stationId}`, combined);

  // 4. July averages — all July days across the 5-year history.
  const julyVals = result.history
    .filter(d => d.date.substring(5, 7) === '07')
    .map(d => d.value);
  if (julyVals.length > 0) {
    result.julyAvg = julyVals.reduce((a, b) => a + b, 0) / julyVals.length;
  }

  // 5. Low water — minimum value within the Jan 1 → today window, using the
  //    combined history + realtime series for maximum date coverage.
  const lowWindow = result.recentDays.filter(
    d => d.date >= LOW_WATER_START && d.date <= LOW_WATER_END
  );
  if (lowWindow.length > 0) {
    result.lowWater = lowWindow.reduce((min, d) => (d.value < min.value ? d : min), lowWindow[0]);
  }

  return result;
}

// ── Fetch discharge (flow) data for a station ──

async function fetchFlowData(stationId) {
  const result = { realtimeDaily: [], history: [], recentDays: null };

  // Realtime discharge (recent ~30 days of sub-daily readings, averaged to daily)
  try {
    const rtFeats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${stationId}&limit=${lim}&offset=${off}`,
      20
    );
    const withDischarge = rtFeats.filter(f => f.properties?.DISCHARGE != null).length;
    console.log(`    realtime: ${rtFeats.length} features, ${withDischarge} with DISCHARGE`);
    result.realtimeDaily = parseRealtime(rtFeats, 'DISCHARGE');
  } catch (e) {
    console.log(`    Realtime flow failed: ${e.message}`);
  }

  // Daily-mean discharge history — use full history window (same as water levels)
  // so we catch data even if the discharge rating curve lags months behind.
  try {
    const feats = await fetchAllFeatures(
      (lim, off) => `${API_BASE}/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${stationId}&datetime=${HISTORY_START}/${TODAY_ISO}&limit=${lim}&offset=${off}`,
      20
    );
    const withDischarge = feats.filter(f => f.properties?.DISCHARGE != null).length;
    console.log(`    daily-mean: ${feats.length} features, ${withDischarge} with DISCHARGE`);
    result.history = parseDaily(feats, 'DISCHARGE');
  } catch (e) {
    console.log(`    Daily-mean flow failed: ${e.message}`);
  }

  // Combine: history + realtime fill for dates history hasn't published yet,
  // then merge with the on-disk cache of past observations
  const histDates = new Set(result.history.map(d => d.date));
  const rtFill = result.realtimeDaily.filter(d => !histDates.has(d.date));
  const combined = [...result.history, ...rtFill].sort((a, b) => a.date.localeCompare(b.date));
  result.recentDays = mergeWithLevelCache(await getLevelCache(), `flow:${stationId}`, combined);

  return result;
}

// ── Main ──

async function main() {
  console.log('🌊 Bala Bay Daily Water Level Notification');
  console.log('──────────────────────────────────────────');

  // Fetch-only mode: update the water temperature cache and exit (no email,
  // no secrets needed). Useful for seeding data/water-temp.csv from a machine
  // whose IP isn't blocked by the ERDDAP servers.
  if (process.argv.includes('--fetch-only')) {
    console.log('Fetch-only mode: updating water temperature cache...');
    const records = await fetchHistoricalWaterTemp();
    console.log(records ? `Done: ${records.length} records in ${TEMP_CSV_PATH}` : 'No records fetched.');
    return;
  }

  // Validate config
  if (!RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY');
  if (EMAIL_TO.length === 0) throw new Error('Missing EMAIL_TO');

  // 1. Fetch Bala station data (realtime + 5-year daily-mean history).
  console.log(`Fetching Bala station data (${STATION})...`);
  const balaData = await fetchStationData(STATION);
  const recentData = balaData.recentDays || [];
  console.log(`  ${balaData.realtimeDaily.length} realtime days, ${balaData.history.length} daily-mean days, ${recentData.length} combined`);

  if (recentData.length === 0) {
    throw new Error('No water level data available for Bala');
  }

  const latest = recentData[recentData.length - 1];
  console.log(`  Latest: ${latest.date} = ${latest.value.toFixed(3)}m`);

  // 2. Compute trend (7-day change if available)
  let trend = null;
  let trendIn = null;
  let trendArrow = '';
  if (recentData.length >= 7) {
    const weekAgo = recentData[recentData.length - 7];
    trend = (latest.value - weekAgo.value) * 100; // in cm
    trendIn = trend / CM_PER_INCH; // in inches
    trendArrow = trend > 0.5 ? '↗ rising' : trend < -0.5 ? '↘ falling' : '→ stable';
    console.log(`  7-day trend: ${trendIn > 0 ? '+' : ''}${trendIn.toFixed(1)}in (${trendArrow})`);
  }

  // 3. July average (computed from 5-year history inside fetchStationData)
  let julyAvg = balaData.julyAvg;
  let deltaCm = null;
  let deltaSign = '';
  let deltaNote = '';

  if (julyAvg !== null) {
    deltaCm = (latest.value - julyAvg) * 100;
    deltaSign = deltaCm >= 0 ? '+' : '';
    deltaNote = deltaCm > 10 ? 'Above normal summer level'
      : deltaCm < -10 ? 'Below normal summer level'
      : deltaCm > 0 ? 'Slightly above normal'
      : deltaCm < 0 ? 'Slightly below normal'
      : 'At normal summer level';
    console.log(`  July avg: ${julyAvg.toFixed(3)}m | Delta: ${deltaSign}${deltaCm.toFixed(1)}cm`);
  }

  // Convert delta and values to inches relative to July average
  const deltaIn = deltaCm !== null ? deltaCm / CM_PER_INCH : null;

  // 4. Fetch water temperature: current + historical for spaghetti chart
  console.log('Fetching water temperature (current + historical)...');
  const [waterTemp, historicalTempRecords] = await Promise.all([
    fetchWaterTemp(),
    fetchHistoricalWaterTemp(),
  ]);
  const tempF = waterTemp ? Math.round(waterTemp.tempC * 9 / 5 + 32) : null;
  const tempYears = historicalTempRecords ? [...new Set(historicalTempRecords.map(r => r.year))] : [];
  const tempGreyYears = tempYears.filter(y => y <= CURRENT_YEAR - 2);
  const tempMinYear = tempGreyYears.length > 0 ? Math.min(...tempGreyYears) : null;
  const tempMaxGreyYear = tempGreyYears.length > 0 ? Math.max(...tempGreyYears) : null;
  if (waterTemp) {
    console.log(`  Water temp: ${waterTemp.tempC}°C (${tempF}°F) — ${waterTemp.date}`);
  } else {
    console.log('  Water temperature unavailable');
  }

  // 5. Bala's low water (from combined history + realtime, Jan 1 → today)
  const balaLowWater = balaData.lowWater;
  if (balaLowWater) console.log(`  Bala low water: ${balaLowWater.date} = ${balaLowWater.value.toFixed(3)}m`);

  // 6. Fetch extra station data (same fetchStationData, parallel).
  console.log('Fetching extra station data...');

  const extraResults = await Promise.all(
    EXTRA_STATIONS.map(async (st) => {
      console.log(`  Fetching ${st.name} (${st.id})...`);
      const data = await fetchStationData(st.id);
      if (data.recentDays) {
        const lat = data.recentDays[data.recentDays.length - 1];
        console.log(`    level=${lat.value.toFixed(3)}m, julyAvg=${data.julyAvg?.toFixed(3) ?? 'N/A'}, lowWater=${data.lowWater ? data.lowWater.date + '=' + data.lowWater.value.toFixed(3) + 'm' : 'N/A'}`);
      } else {
        console.log(`    no data`);
      }
      return {
        ...st,
        recentDays: data.recentDays,
        history: data.history,
        realtimeDaily: data.realtimeDaily,
        julyAvg: data.julyAvg,
        lowWater: data.lowWater,
      };
    })
  );

  // 7. Fetch flow rate data for river stations (parallel).
  console.log('Fetching flow rate data...');

  const flowResults = await Promise.all(
    FLOW_STATIONS.map(async (st) => {
      console.log(`  Fetching flow ${st.name} (${st.id})...`);
      const data = await fetchFlowData(st.id);
      if (data.recentDays && data.recentDays.length > 0) {
        const lat = data.recentDays[data.recentDays.length - 1];
        console.log(`    flow=${lat.value.toFixed(1)} m³/s (${data.recentDays.length} days)`);
      } else {
        console.log(`    no discharge data`);
      }
      return { ...st, recentDays: data.recentDays };
    })
  );

  // All station/flow fetches are done — persist the observation cache so the
  // workflow's data-commit step picks it up
  await saveLevelCache();
  console.log('  Level/flow observation cache saved');

  // 8. Dump diagnostic CSV with all computed values
  {
    const csvRows = ['Station,Body of Water,Latest Date,Level (m),July Avg (m),Low Water Date,Low Water Level (m),Above Low (in),Below Summer (in),1d Chg (in),2d Chg (in),3d Chg (in)'];
    function csvRow(name, label, days, stJulyAvg, lowWater) {
      if (!days || days.length === 0) return;
      const lat = days[days.length - 1];
      const level = lat.value;
      const aboveLow = lowWater ? ((level - lowWater.value) * 100 / CM_PER_INCH).toFixed(2) : '';
      const belowSum = stJulyAvg !== null ? ((level - stJulyAvg) * 100 / CM_PER_INCH).toFixed(2) : '';
      const chg = (n) => days.length > n ? (((level - days[days.length - 1 - n].value) * 100 / CM_PER_INCH).toFixed(2)) : '';
      csvRows.push([name, label, lat.date, level.toFixed(4), stJulyAvg?.toFixed(4) ?? '', lowWater?.date ?? '', lowWater?.value.toFixed(4) ?? '', aboveLow, belowSum, chg(1), chg(2), chg(3)].join(','));
    }
    csvRow('Bala', 'Lake Muskoka', recentData, julyAvg, balaLowWater);
    for (const s of extraResults) csvRow(s.name, s.label, s.recentDays, s.julyAvg, s.lowWater);
    console.log('\n── Diagnostic CSV ──');
    for (const row of csvRows) console.log(row);
    console.log('── End CSV ──\n');
  }

  // 6b. Build temperature spaghetti chart (PNG)
  let tempChartBuffer = null;
  try {
    if (historicalTempRecords && historicalTempRecords.length > 0) {
      tempChartBuffer = await buildTempSpaghettiChart(historicalTempRecords);
    }
  } catch (e) {
    console.log(`  Spaghetti chart generation failed: ${e.message}`);
  }

  // 7. Build and send email
  console.log('Sending email...');

  const dateStr = new Date(latest.date + 'T12:00:00').toLocaleDateString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  // Build water level charts (HTML)
  const waterLevelChartInputs = [
    { name: 'Bala', label: 'Lake Muskoka', days: recentData, julyAvg, stationId: STATION, isFirst: true },
    ...extraResults
      .filter(s => s.recentDays && s.recentDays.length > 0)
      .map(s => ({ name: s.name, label: s.label, days: s.recentDays, julyAvg: s.julyAvg, stationId: s.id, isFirst: false })),
  ];
  const waterLevelCharts = [];
  for (const input of waterLevelChartInputs) {
    try {
      const result = buildWaterLevelChart(input.name, input.label, input.days, input.julyAvg, input.isFirst, input.stationId);
      if (result) waterLevelCharts.push(result);
    } catch (e) {
      console.log(`  Chart for ${input.name} failed: ${e.message}`);
    }
  }

  // Build Beaumaris–Bala spread chart
  let spreadChart = null;
  try {
    const beaumaris = extraResults.find(s => s.id === '02EB018');
    if (beaumaris && beaumaris.recentDays) {
      spreadChart = buildSpreadChart(recentData, julyAvg, beaumaris.recentDays, beaumaris.julyAvg);
    }
  } catch (e) {
    console.log(`  Spread chart failed: ${e.message}`);
  }

  const deltaColor = deltaCm > 10 ? '#E07B4C'
    : deltaCm < -10 ? '#2D6A9F'
    : '#5BA88A';

  // Build area water levels table
  const areaTableHtml = (() => {
    const td = 'padding:3px 4px;font-size:10px;color:#0B1D33;border-bottom:1px solid #F0EDE8;white-space:nowrap;';
    const th = 'padding:3px 4px;font-size:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;color:#6B6B6B;border-bottom:2px solid #E0DAD2;white-space:nowrap;';
    const tdr = td + 'text-align:right;';
    const thr = th + 'text-align:right;';

    function buildRow(name, label, days, stJulyAvg, lowWater, isBala, stationId) {
      if (!days || days.length === 0) return '';
      const lat = days[days.length - 1];
      const level = lat.value;

      const belowSummer = stJulyAvg !== null ? ((level - stJulyAvg) * 100 / CM_PER_INCH) : null;
      const belowSummerStr = belowSummer !== null ? (belowSummer >= 0 ? '+' : '') + belowSummer.toFixed(1) : '\u2014';

      const hwm = HIGH_WATER_MARKS[stationId];
      const vsHigh = hwm ? ((level - hwm.level) * 100 / CM_PER_INCH) : null;
      const vsHighStr = vsHigh !== null ? (vsHigh >= 0 ? '+' : '') + vsHigh.toFixed(1) : '\u2014';

      function dayChange(n) {
        if (days.length <= n) return '\u2014';
        const prev = days[days.length - 1 - n];
        const chg = (level - prev.value) * 100 / CM_PER_INCH;
        return (chg >= 0 ? '+' : '') + chg.toFixed(1);
      }

      const bold = isBala ? 'font-weight:600;' : '';
      return '<tr>'
        + '<td style="' + td + bold + '">' + name + '</td>'
        + '<td style="' + td + 'font-size:9px;color:#6B6B6B;">' + label + '</td>'
        + '<td style="' + tdr + '">' + level.toFixed(3) + '</td>'
        + '<td style="' + tdr + '">' + belowSummerStr + '</td>'
        + '<td style="' + tdr + '">' + vsHighStr + '</td>'
        + '<td style="' + tdr + '">' + dayChange(1) + '</td>'
        + '<td style="' + tdr + '">' + dayChange(2) + '</td>'
        + '<td style="' + tdr + '">' + dayChange(3) + '</td>'
        + '</tr>';
    }

    const balaRow = buildRow('Bala', 'Lake Muskoka', recentData, julyAvg, balaLowWater, true, STATION);
    const extraRows = extraResults.filter(s => s.recentDays).map(s =>
      buildRow(s.name, s.label, s.recentDays, s.julyAvg, s.lowWater, false, s.id)
    ).join('');

    return '<div style="margin-bottom:16px;overflow-x:auto;">'
      + '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:8px;">Area Water Levels</div>'
      + '<table style="width:100%;border-collapse:collapse;">'
      + '<tr>'
      + '<th style="' + th + '">Stn</th>'
      + '<th style="' + th + '">Water</th>'
      + '<th style="' + thr + '">Lvl (m)</th>'
      + '<th style="' + thr + '">vs Sum</th>'
      + '<th style="' + thr + '">vs Hi</th>'
      + '<th style="' + thr + '">1d</th>'
      + '<th style="' + thr + '">2d</th>'
      + '<th style="' + thr + '">3d</th>'
      + '</tr>'
      + balaRow
      + extraRows
      + '</table></div>';
  })();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F4F0EB;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="margin-bottom:20px;">
      <h1 style="margin:0;font-size:20px;color:#0B1D33;">🌊 Bala Bay</h1>
      <p style="margin:4px 0 0;font-size:13px;color:#6B6B6B;">${dateStr}</p>
    </div>

    <!-- Main card -->
    <div style="background:#fff;border:1px solid #E0DAD2;border-radius:12px;padding:20px;margin-bottom:16px;">

      <!-- Current level -->
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">Current Level vs July Avg</div>
        <div style="font-size:28px;font-weight:700;color:#0B1D33;">${deltaSign}${deltaIn?.toFixed(1) ?? '?'}<span style="font-size:14px;color:#6B6B6B;margin-left:2px;">in</span></div>
      </div>

      ${waterTemp ? `
      <!-- Water Temperature -->
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">Water Temperature</div>
        <div style="font-size:28px;font-weight:700;color:#0B1D33;">${waterTemp.tempC.toFixed(1)}<span style="font-size:14px;color:#6B6B6B;margin-left:2px;">°C</span> <span style="font-size:16px;font-weight:400;color:#6B6B6B;">(${tempF}°F)</span></div>
      </div>
      ` : ''}

      ${tempChartBuffer ? `
      <!-- Water Temperature Spaghetti Chart (CID inline image — Gmail strips data: URIs) -->
      <div style="margin-bottom:16px;">
        <img src="cid:temp-chart" alt="Water temperature year-over-year chart" style="width:100%;max-width:560px;height:auto;border-radius:8px;border:1px solid #E0DAD2;display:block;" />
        <div style="margin-top:6px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:16px;border-top:2.5px solid #2D6A9F;vertical-align:middle;margin-right:4px;"></span>${CURRENT_YEAR} YTD
          <span style="display:inline-block;width:16px;border-top:2px solid #C0392B;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>${CURRENT_YEAR - 1}
          ${tempMinYear !== null && tempMinYear <= CURRENT_YEAR - 2 ? `<span style="display:inline-block;width:16px;border-top:1px solid rgba(150,150,150,0.7);vertical-align:middle;margin-left:10px;margin-right:4px;"></span>${tempMinYear < tempMaxGreyYear ? `${tempMinYear}\u2013${tempMaxGreyYear}` : tempMaxGreyYear}` : ''}
        </div>
        <div style="font-size:8px;color:#BBB;margin-top:2px;">Source: NOAA MUR SST v4.1</div>
      </div>
      ` : ''}

      ${trend !== null ? `
      <!-- Trend -->
      <div style="font-size:13px;color:#6B6B6B;margin-bottom:16px;">
        <strong>7-day trend:</strong> ${trendIn > 0 ? '+' : ''}${trendIn.toFixed(1)} in ${trendArrow}
      </div>
      ` : ''}

      <!-- Area Water Levels -->
      ${areaTableHtml}

      <!-- Water Level Charts: Bala + extra stations -->
      ${waterLevelCharts.map(c => c.html).join('')}

      <!-- Beaumaris–Bala Spread Chart -->
      ${spreadChart ? spreadChart.html : ''}

      <!-- Flow Rate Charts -->
      ${flowResults.filter(s => s.recentDays && s.recentDays.length > 0).length > 0 ? `
      <div style="margin-top:24px;border-top:2px solid #E0DAD2;padding-top:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">River Flow Rates</div>
        ${flowResults
          .filter(s => s.recentDays && s.recentDays.length > 0)
          .map((s, i) => buildFlowChart(s.name, s.label, s.recentDays, i === 0))
          .join('')}
      </div>
      ` : ''}
    </div>

    <!-- Footer -->
    <div style="text-align:center;font-size:11px;color:#6B6B6B;line-height:1.5;">
      Station 02EB015 · Lake Muskoka, Ontario<br>
      Data: Environment Canada, MSC Open Data${waterTemp ? ' · NOAA MUR SST' : ''}
    </div>
  </div>
</body>
</html>`;

  const balaText = txtRow('Bala', 'Lake Muskoka', recentData, julyAvg, balaLowWater);
  const extraText = extraResults.filter(s => s.recentDays).map(s =>
    txtRow(s.name, s.label, s.recentDays, s.julyAvg, s.lowWater)
  ).filter(Boolean).join('\n');
  const flowText = flowResults
    .filter(s => s.recentDays && s.recentDays.length > 0)
    .map(s => {
      const lat = s.recentDays[s.recentDays.length - 1];
      return `  ${s.name} (${s.label}): ${lat.value.toFixed(1)} m³/s`;
    }).join('\n');
  const text = [
    `🌊 Bala Bay Water Level — ${dateStr}`,
    ``,
    `Current: ${deltaSign}${deltaIn?.toFixed(1) ?? '?'} in vs July avg`,
    waterTemp ? `Water temp: ${waterTemp.tempC.toFixed(1)}°C (${tempF}°F)` : '',
    julyAvg !== null ? `${deltaNote}` : '',
    trend !== null ? `7-day trend: ${trendIn > 0 ? '+' : ''}${trendIn.toFixed(1)} in ${trendArrow}` : '',
    ``,
    `Area Water Levels:`,
    balaText,
    extraText,
    flowText ? `\nRiver Flow Rates:\n${flowText}` : '',
    ``,
    `Station 02EB015 · Lake Muskoka · Environment Canada${waterTemp ? ' · NOAA MUR SST' : ''}`,
  ].filter(Boolean).join('\n');

  // Send via Resend
  const emailResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: EMAIL_TO,
      subject: `🌊 Bala Bay: ${deltaSign}${deltaIn?.toFixed(1) ?? '?'} in vs July avg${waterTemp ? ` · ${waterTemp.tempC.toFixed(1)}°C` : ''}`,
      html: html,
      text: text,
      ...(tempChartBuffer ? {
        attachments: [{
          filename: 'water-temp-chart.png',
          content: tempChartBuffer.toString('base64'),
          content_id: 'temp-chart',
        }],
      } : {}),
    }),
  });

  if (!emailResp.ok) {
    const err = await emailResp.text();
    throw new Error(`Resend API error: ${emailResp.status} — ${err}`);
  }

  const result = await emailResp.json();
  console.log(`✅ Email sent! ID: ${result.id}`);
  console.log(`   To: ${EMAIL_TO.join(', ')}`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
