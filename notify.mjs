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
 *   NOAA ERDDAP MUR SST (coastwatch.pfeg.noaa.gov) — water temperature
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
// 60-day chart backfill, and the CSV attachment).
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
const ERDDAP_BASE = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap';

// ── Configuration (from environment variables) ──
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = (process.env.EMAIL_TO || '').split(',').map(e => e.trim()).filter(Boolean);
const EMAIL_FROM = process.env.EMAIL_FROM || 'Bala Bay <onboarding@resend.dev>';

// ── Fetch helpers ──

async function fetchJSON(url) {
  const resp = await fetch(url);
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

function parseRealtimeFeatures(features) {
  const dayMap = {};
  for (const f of features) {
    const p = f.properties || {};
    if (p.LEVEL == null) continue;
    const d = (p.DATETIME || '').substring(0, 10);
    if (!d) continue;
    if (!dayMap[d]) dayMap[d] = [];
    dayMap[d].push(p.LEVEL);
  }
  return Object.entries(dayMap)
    .map(([date, v]) => ({ date, value: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseDailyFeatures(features) {
  const results = [];
  for (const f of features) {
    const p = f.properties || {};
    if (p.LEVEL == null) continue;
    const date = (p.DATE || '').substring(0, 10);
    if (date) results.push({ date, value: p.LEVEL });
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

function parseRealtimeDischarge(features) {
  const dayMap = {};
  for (const f of features) {
    const p = f.properties || {};
    if (p.DISCHARGE == null) continue;
    const d = (p.DATETIME || '').substring(0, 10);
    if (!d) continue;
    if (!dayMap[d]) dayMap[d] = [];
    dayMap[d].push(p.DISCHARGE);
  }
  return Object.entries(dayMap)
    .map(([date, v]) => ({ date, value: v.reduce((a, b) => a + b, 0) / v.length }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parseDailyDischarge(features) {
  const results = [];
  for (const f of features) {
    const p = f.properties || {};
    if (p.DISCHARGE == null) continue;
    const date = (p.DATE || '').substring(0, 10);
    if (date) results.push({ date, value: p.DISCHARGE });
  }
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Outlier filter ──

function filterOutliers(data) {
  if (data.length < 4) return data;
  const clean = [data[0]];
  for (let i = 1; i < data.length - 1; i++) {
    const avg = (data[i - 1].value + data[i + 1].value) / 2;
    if (Math.abs(data[i].value - avg) > 0.5) {
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
  // Uses "last" to get most recent available data point
  const url = `${ERDDAP_BASE}/jplMURSST41.json?analysed_sst[(last)][(${BALA_LAT})][(${BALA_LON})]`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    const rows = data?.table?.rows;
    if (!rows || rows.length === 0) return null;
    // Row format: [time, latitude, longitude, analysed_sst]
    const sst = rows[0][3];
    if (sst == null) return null; // land-masked or missing
    const time = rows[0][0];
    const date = time ? time.substring(0, 10) : null;
    return { tempC: Math.round(sst * 10) / 10, date };
  } catch (e) {
    console.log(`  Water temp fetch failed: ${e.message}`);
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

async function fetchHistoricalWaterTemp() {
  try {
    const cached = await loadCachedTemp();
    const latestCached = cached.length > 0 ? cached[cached.length - 1].date : null;

    let startDate;
    if (latestCached) {
      const next = new Date(latestCached + 'T12:00:00Z');
      next.setUTCDate(next.getUTCDate() + 1);
      startDate = next.toISOString().substring(0, 10);
    } else {
      startDate = '2002-06-01';
    }

    if (startDate > TODAY_ISO) {
      console.log(`  Historical temp: cache is current (${cached.length} records)`);
      return cached;
    }

    console.log(`  Fetching temp data from ${startDate} to ${TODAY_ISO}${latestCached ? ` (${cached.length} cached)` : ' (full fetch)'}...`);
    const url = `${ERDDAP_BASE}/jplMURSST41.csv?analysed_sst[(${startDate}):(${TODAY_ISO})][(${BALA_LAT})][(${BALA_LON})]`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const newRecords = parseERDDAPCsv(await resp.text());

    // Merge: cached + new, deduplicate by date
    const byDate = new Map(cached.map(r => [r.date, r]));
    for (const r of newRecords) byDate.set(r.date, r);
    const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

    await saveTempCache(all);
    console.log(`  Historical temp: ${all.length} records across ${new Set(all.map(r => r.year)).size} years (${newRecords.length} new)`);
    return all;
  } catch (e) {
    console.log(`  Historical water temp fetch failed: ${e.message}`);
    const cached = await loadCachedTemp();
    if (cached.length > 0) {
      console.log(`  Falling back to cached data (${cached.length} records)`);
      return cached;
    }
    return null;
  }
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
    const data = byYear[year]
      .sort((a, b) => a.dayOfYear - b.dayOfYear)
      .map(r => ({ x: r.dayOfYear, y: r.tempC }));

    let color, width, order;
    if (year === currentYear) {
      color = '#2D6A9F';
      width = 2.5;
      order = 0;
    } else if (year === prevYear) {
      color = '#444444';
      width = 1.5;
      order = 1;
    } else {
      color = 'rgba(180, 180, 180, 0.4)';
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
          ticks: {
            callback: (val) => {
              const idx = monthStarts.indexOf(val);
              return idx >= 0 ? monthLabels[idx] : '';
            },
            values: monthStarts,
            font: { size: 10, family: 'sans-serif' },
            color: '#6B6B6B',
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
    result.realtimeDaily = filterOutliers(parseRealtimeFeatures(rtFeats));
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
    result.history = parseDailyFeatures(feats);
  } catch (e) {
    console.log(`    Daily-mean history failed: ${e.message}`);
  }

  // 3. Combine history + realtime (realtime fills dates daily-mean hasn't published yet).
  const histDates = new Set(result.history.map(d => d.date));
  const rtFill = result.realtimeDaily.filter(d => !histDates.has(d.date));
  result.recentDays = [...result.history, ...rtFill].sort((a, b) => a.date.localeCompare(b.date));

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
    result.realtimeDaily = parseRealtimeDischarge(rtFeats);
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
    result.history = parseDailyDischarge(feats);
  } catch (e) {
    console.log(`    Daily-mean flow failed: ${e.message}`);
  }

  // Combine: history + realtime fill for dates history hasn't published yet
  const histDates = new Set(result.history.map(d => d.date));
  const rtFill = result.realtimeDaily.filter(d => !histDates.has(d.date));
  result.recentDays = [...result.history, ...rtFill].sort((a, b) => a.date.localeCompare(b.date));

  return result;
}

// ── Main ──

async function main() {
  console.log('🌊 Bala Bay Daily Water Level Notification');
  console.log('──────────────────────────────────────────');

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
    trendIn = trend / 2.54; // in inches
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
  const deltaIn = deltaCm !== null ? deltaCm / 2.54 : null;

  // 4. Fetch water temperature: current + historical for spaghetti chart
  console.log('Fetching water temperature (current + historical)...');
  const [waterTemp, historicalTempRecords] = await Promise.all([
    fetchWaterTemp(),
    fetchHistoricalWaterTemp(),
  ]);
  if (waterTemp) {
    console.log(`  Water temp: ${waterTemp.tempC}°C (${(waterTemp.tempC * 9/5 + 32).toFixed(0)}°F) — ${waterTemp.date}`);
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

  // 8. Dump diagnostic CSV with all computed values
  {
    const csvRows = ['Station,Body of Water,Latest Date,Level (m),July Avg (m),Low Water Date,Low Water Level (m),Above Low (in),Below Summer (in),1d Chg (in),2d Chg (in),3d Chg (in)'];
    function csvRow(name, label, days, stJulyAvg, lowWater) {
      if (!days || days.length === 0) return;
      const lat = days[days.length - 1];
      const level = lat.value;
      const aboveLow = lowWater ? ((level - lowWater.value) * 100 / 2.54).toFixed(2) : '';
      const belowSum = stJulyAvg !== null ? ((level - stJulyAvg) * 100 / 2.54).toFixed(2) : '';
      const chg = (n) => days.length > n ? (((level - days[days.length - 1 - n].value) * 100 / 2.54).toFixed(2)) : '';
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

  // Pre-render water level chart images (PNG)
  const waterLevelChartInputs = [
    { name: 'Bala', label: 'Lake Muskoka', days: recentData, julyAvg, stationId: STATION, isFirst: true },
    ...extraResults
      .filter(s => s.recentDays && s.recentDays.length > 0)
      .map(s => ({ name: s.name, label: s.label, days: s.recentDays, julyAvg: s.julyAvg, stationId: s.id, isFirst: false })),
  ];
  const waterLevelCharts = [];
  for (const input of waterLevelChartInputs) {
    try {
      const result = await buildWaterLevelChart(input.name, input.label, input.days, input.julyAvg, input.isFirst, input.stationId);
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
      spreadChart = await buildSpreadChart(recentData, julyAvg, beaumaris.recentDays, beaumaris.julyAvg);
    }
  } catch (e) {
    console.log(`  Spread chart failed: ${e.message}`);
  }

  // Water level chart builder: 60-day bar chart rendered as PNG image.
  // Returns { html, buffer, cid } where buffer is the PNG and cid is the Content-ID.
  async function buildWaterLevelChart(name, label, days, stJulyAvg, isFirst, stationId) {
    if (!days || days.length === 0) return null;
    const chartDays = days.slice(-60);
    const hwm = stationId ? HIGH_WATER_MARKS[stationId] : null;

    const latest = chartDays[chartDays.length - 1];
    const vsJulyStr = stJulyAvg !== null
      ? (() => {
          const diffIn = (latest.value - stJulyAvg) * 100 / 2.54;
          return ` \u00b7 ${diffIn >= 0 ? '+' : ''}${diffIn.toFixed(1)}in vs Jul avg`;
        })()
      : '';

    const fmtShort = (d) => new Date(d.date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });

    const barColors = chartDays.map((_, i) =>
      i === chartDays.length - 1 ? '#E07B4C' : '#4A9BD9'
    );

    const refLinesPlugin = {
      id: 'refLines',
      afterDraw(chart) {
        const ctx = chart.ctx;
        const yScale = chart.scales.y;
        const { left, right } = chart.chartArea;

        if (stJulyAvg !== null) {
          const y = yScale.getPixelForValue(stJulyAvg);
          if (y >= chart.chartArea.top && y <= chart.chartArea.bottom) {
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = '#5BA88A';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = '10px sans-serif';
            ctx.fillStyle = '#5BA88A';
            ctx.textAlign = 'right';
            ctx.fillText('Jul avg', right, y - 4);
            ctx.restore();
          }
        }

        if (hwm) {
          const y = yScale.getPixelForValue(hwm.level);
          if (y >= chart.chartArea.top - 5 && y <= chart.chartArea.bottom) {
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = '#C0392B';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = '10px sans-serif';
            ctx.fillStyle = '#C0392B';
            ctx.textAlign = 'right';
            ctx.fillText(`${hwm.year} high`, right, y - 4);
            ctx.restore();
          }
        }
      }
    };

    const chartWidth = 520;
    const chartHeight = 150;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
      width: chartWidth,
      height: chartHeight,
      backgroundColour: '#FFFFFF',
    });

    const yMin = Math.min(...chartDays.map(d => d.value));
    const yMax = Math.max(...chartDays.map(d => d.value), stJulyAvg ?? 0, hwm ? hwm.level : 0);
    const yPadding = (yMax - yMin) * 0.08 || 0.01;

    const config = {
      type: 'bar',
      plugins: [refLinesPlugin],
      data: {
        labels: chartDays.map(d => fmtShort(d)),
        datasets: [{
          data: chartDays.map(d => d.value),
          backgroundColor: barColors,
          borderWidth: 0,
          barPercentage: 0.9,
          categoryPercentage: 0.95,
        }],
      },
      options: {
        responsive: false,
        animation: false,
        scales: {
          x: {
            ticks: {
              maxTicksLimit: 5,
              font: { size: 9, family: 'sans-serif' },
              color: '#999',
            },
            grid: { display: false },
          },
          y: {
            min: yMin - yPadding,
            max: yMax + yPadding,
            ticks: {
              font: { size: 9, family: 'sans-serif' },
              color: '#6B6B6B',
              callback: (v) => v.toFixed(2),
              maxTicksLimit: 5,
            },
            grid: { color: '#F0EDE8' },
          },
        },
        plugins: {
          title: {
            display: true,
            text: [`${name} — ${label}`, `Water Level — Last ${chartDays.length} Days${vsJulyStr}`],
            font: [
              { size: 11, weight: '600', family: 'sans-serif' },
              { size: 9, weight: 'normal', family: 'sans-serif' },
            ],
            color: ['#6B6B6B', '#999'],
            padding: { bottom: 4 },
          },
          legend: { display: false },
          tooltip: { enabled: false },
        },
        layout: { padding: { left: 2, right: 8, top: 0, bottom: 2 } },
      },
    };

    const buffer = await chartJSNodeCanvas.renderToBuffer(config);
    const cid = `water-chart-${stationId || name.toLowerCase()}`;

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
        <img src="cid:${cid}" alt="${name} water level chart" style="width:100%;max-width:${chartWidth}px;height:auto;border-radius:4px;" />
        <div style="margin-top:4px;font-size:9px;color:#999;">${legendItems.join('\n          ')}</div>
      </div>`;

    return { html, buffer, cid };
  }

  // Spread chart: Beaumaris vs Bala water level difference (normalized to July avg)
  async function buildSpreadChart(balaDays, balaJulyAvg, beauDays, beauJulyAvg) {
    if (!balaDays || !beauDays || balaJulyAvg === null || beauJulyAvg === null) return null;

    const balaByDate = new Map(balaDays.map(d => [d.date, d.value]));
    const spreadDays = [];
    for (const d of beauDays) {
      const balaVal = balaByDate.get(d.date);
      if (balaVal === undefined) continue;
      const spreadIn = ((d.value - beauJulyAvg) - (balaVal - balaJulyAvg)) * 100 / 2.54;
      spreadDays.push({ date: d.date, spread: spreadIn });
    }
    if (spreadDays.length === 0) return null;

    const chartDays = spreadDays.slice(-60);
    const fmtShort = (d) => new Date(d.date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });

    const barColors = chartDays.map(d => d.spread >= 0 ? '#4A9BD9' : '#E07B4C');
    const latestSpread = chartDays[chartDays.length - 1].spread;

    const zeroLinePlugin = {
      id: 'zeroLine',
      afterDraw(chart) {
        const ctx = chart.ctx;
        const yScale = chart.scales.y;
        const { left, right } = chart.chartArea;
        const y = yScale.getPixelForValue(0);
        if (y >= chart.chartArea.top && y <= chart.chartArea.bottom) {
          ctx.save();
          ctx.strokeStyle = '#666';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(right, y);
          ctx.stroke();
          ctx.restore();
        }
      }
    };

    const chartWidth = 520;
    const chartHeight = 150;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({
      width: chartWidth,
      height: chartHeight,
      backgroundColour: '#FFFFFF',
    });

    const values = chartDays.map(d => d.spread);
    const yMin = Math.min(...values);
    const yMax = Math.max(...values);
    const yPadding = Math.max((yMax - yMin) * 0.15, 0.5);

    const config = {
      type: 'bar',
      plugins: [zeroLinePlugin],
      data: {
        labels: chartDays.map(d => fmtShort(d)),
        datasets: [{
          data: values,
          backgroundColor: barColors,
          borderWidth: 0,
          barPercentage: 0.9,
          categoryPercentage: 0.95,
        }],
      },
      options: {
        responsive: false,
        animation: false,
        scales: {
          x: {
            ticks: { maxTicksLimit: 5, font: { size: 9, family: 'sans-serif' }, color: '#999' },
            grid: { display: false },
          },
          y: {
            min: Math.min(yMin - yPadding, -0.5),
            max: Math.max(yMax + yPadding, 0.5),
            ticks: {
              font: { size: 9, family: 'sans-serif' },
              color: '#6B6B6B',
              callback: (v) => (v >= 0 ? '+' : '') + v.toFixed(1),
              maxTicksLimit: 5,
            },
            grid: { color: '#F0EDE8' },
          },
        },
        plugins: {
          title: {
            display: true,
            text: [
              'Beaumaris vs Bala \u2014 Water Level Spread',
              `Last ${chartDays.length} Days \u00b7 Current: ${latestSpread >= 0 ? '+' : ''}${latestSpread.toFixed(1)}in`,
            ],
            font: [
              { size: 11, weight: '600', family: 'sans-serif' },
              { size: 9, weight: 'normal', family: 'sans-serif' },
            ],
            color: ['#6B6B6B', '#999'],
            padding: { bottom: 4 },
          },
          legend: { display: false },
          tooltip: { enabled: false },
        },
        layout: { padding: { left: 2, right: 8, top: 0, bottom: 2 } },
      },
    };

    const buffer = await chartJSNodeCanvas.renderToBuffer(config);
    const cid = 'spread-chart-beau-bala';

    const html = `
      <div style="margin-top:20px;border-top:1px solid #E0DAD2;padding-top:16px;">
        <img src="cid:${cid}" alt="Beaumaris vs Bala water level spread" style="width:100%;max-width:${chartWidth}px;height:auto;border-radius:4px;" />
        <div style="margin-top:4px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:8px;height:8px;background:#4A9BD9;border-radius:1px;vertical-align:middle;margin-right:3px;"></span>Beaumaris above Bala
          <span style="display:inline-block;width:8px;height:8px;background:#E07B4C;border-radius:1px;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>Bala above Beaumaris
        </div>
        <div style="font-size:8px;color:#BBB;margin-top:2px;">Normalized to each station\u2019s 5-year July average (inches)</div>
      </div>`;

    return { html, buffer, cid };
  }

  // Flow rate chart builder: 60-day bar chart for discharge (m³/s).
  function buildFlowChart(name, label, days, isFirst) {
    if (!days || days.length === 0) return '';
    const chartDays = days.slice(-60);
    const minVal = Math.min(...chartDays.map(d => d.value));
    const maxVal = Math.max(...chartDays.map(d => d.value));
    const range = maxVal - minVal || 0.01;
    const chartHeight = 120; // px

    const bars = chartDays.map((d, i) => {
      const pct = (d.value - minVal) / range;
      const height = Math.max(3, Math.round(pct * (chartHeight - 10) + 3));
      const color = i === chartDays.length - 1 ? '#E07B4C' : '#6B8EAD';
      return `<td style="vertical-align:bottom;padding:0 0.5px;"><div style="width:6px;height:${height}px;background:${color};border-radius:1px;" title="${d.date}: ${d.value.toFixed(1)} m³/s"></div></td>`;
    }).join('');

    const fmtShort = (d) => new Date(d.date + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
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
        <div style="font-size:9px;color:#999;margin-bottom:8px;">Flow Rate — Last ${chartDays.length} Days · ${latest.value.toFixed(1)} m³/s</div>
        <div style="display:inline-block;">
          <div style="position:relative;border-bottom:1px solid #E0DAD2;padding-left:2px;">
            <table style="border-collapse:collapse;height:${chartHeight}px;"><tr>${bars}</tr></table>
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

      const belowSummer = stJulyAvg !== null ? ((level - stJulyAvg) * 100 / 2.54) : null;
      const belowSummerStr = belowSummer !== null ? (belowSummer >= 0 ? '+' : '') + belowSummer.toFixed(1) : '\u2014';

      const hwm = HIGH_WATER_MARKS[stationId];
      const vsHigh = hwm ? ((level - hwm.level) * 100 / 2.54) : null;
      const vsHighStr = vsHigh !== null ? (vsHigh >= 0 ? '+' : '') + vsHigh.toFixed(1) : '\u2014';

      function dayChange(n) {
        if (days.length <= n) return '\u2014';
        const prev = days[days.length - 1 - n];
        const chg = (level - prev.value) * 100 / 2.54;
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
        <div style="font-size:28px;font-weight:700;color:#0B1D33;">${waterTemp.tempC.toFixed(1)}<span style="font-size:14px;color:#6B6B6B;margin-left:2px;">°C</span> <span style="font-size:16px;font-weight:400;color:#6B6B6B;">(${(waterTemp.tempC * 9/5 + 32).toFixed(0)}°F)</span></div>
      </div>
      ` : ''}

      ${tempChartBuffer ? `
      <!-- Water Temperature Spaghetti Chart -->
      <div style="margin-bottom:16px;">
        <img src="cid:temp-spaghetti-chart" alt="Water temperature year-over-year chart" style="width:100%;max-width:560px;height:auto;border-radius:8px;border:1px solid #E0DAD2;" />
        <div style="margin-top:6px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:16px;border-top:2.5px solid #2D6A9F;vertical-align:middle;margin-right:4px;"></span>${CURRENT_YEAR} YTD
          <span style="display:inline-block;width:16px;border-top:1.5px solid #444;vertical-align:middle;margin-left:10px;margin-right:4px;"></span>${CURRENT_YEAR - 1}
          <span style="display:inline-block;width:16px;border-top:1px solid rgba(180,180,180,0.6);vertical-align:middle;margin-left:10px;margin-right:4px;"></span>2002\u2013${CURRENT_YEAR - 2}
        </div>
        <div style="font-size:8px;color:#BBB;margin-top:2px;">Source: NOAA MUR SST v4.1</div>
      </div>
      ` : ''}

      ${julyAvg !== null ? `
      <!-- Delta -->
      <div style="background:#F8F6F2;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">vs 5-Year July Average</div>
        <div style="font-size:24px;font-weight:700;color:${deltaColor};">${deltaSign}${deltaIn.toFixed(1)} in</div>
        <div style="font-size:12px;color:#6B6B6B;margin-top:2px;">${deltaNote}</div>
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

  // Plain text fallback
  function txtRow(name, label, recentDays, stJulyAvg, lowWater) {
    if (!recentDays || recentDays.length === 0) return null;
    const lat = recentDays[recentDays.length - 1];
    const aboveLow = lowWater ? ((lat.value - lowWater.value) * 100 / 2.54).toFixed(1) : '?';
    const belowSum = stJulyAvg !== null ? ((lat.value - stJulyAvg) * 100 / 2.54).toFixed(1) : '?';
    return `  ${name} (${label}): ${lat.value.toFixed(3)}m | ↑low:${aboveLow}in | ↓summer:${belowSum}in`;
  }
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
    waterTemp ? `Water temp: ${waterTemp.tempC.toFixed(1)}°C (${(waterTemp.tempC * 9/5 + 32).toFixed(0)}°F)` : '',
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

  // Build CSV attachment: full 5+ year daily water level history for all 5 stations.
  // Each row is (date, station, name, water_body, level_m, source) where source
  // is "daily-mean" (authoritative historical value) or "realtime" (averaged from
  // sub-daily readings, used to fill recent dates daily-mean hasn't published yet).
  // Note: level_m is the raw LEVEL as reported by MSC — some stations report
  // absolute elevation (e.g. Bala) while others report gauge height from a
  // local datum, so values are NOT directly comparable across stations.
  const csvLines = ['date,station_number,station_name,water_body,level_m,source'];
  function appendStationRows(stationNumber, stationName, waterBody, history, realtimeDaily) {
    const histDates = new Set((history || []).map(d => d.date));
    for (const d of history || []) {
      csvLines.push([d.date, stationNumber, stationName, waterBody, d.value.toFixed(4), 'daily-mean'].join(','));
    }
    for (const d of realtimeDaily || []) {
      if (histDates.has(d.date)) continue; // already covered by daily-mean
      csvLines.push([d.date, stationNumber, stationName, waterBody, d.value.toFixed(4), 'realtime'].join(','));
    }
  }
  appendStationRows(STATION, 'Bala', 'Lake Muskoka', balaData.history, balaData.realtimeDaily);
  for (const s of extraResults) {
    appendStationRows(s.id, s.name, s.label, s.history, s.realtimeDaily);
  }
  // Sort rows by (station_number, date) for readability — header stays first.
  const header = csvLines[0];
  const rows = csvLines.slice(1).sort((a, b) => {
    const ca = a.split(',');
    const cb = b.split(',');
    if (ca[1] !== cb[1]) return ca[1].localeCompare(cb[1]);
    return ca[0].localeCompare(cb[0]);
  });
  const csvContent = [header, ...rows].join('\n') + '\n';
  console.log(`  CSV: ${rows.length} rows, ${csvContent.length} bytes`);
  const csvAttachment = {
    filename: `water-levels-${latest.date}.csv`,
    content: Buffer.from(csvContent, 'utf8').toString('base64'),
  };

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
      subject: `🌊 Bala Bay: ${deltaSign}${deltaIn?.toFixed(1) ?? '?'} in vs July avg${waterTemp ? ` · ${waterTemp.tempC.toFixed(0)}°C` : ''}`,
      html: html,
      text: text,
      attachments: [
        csvAttachment,
        ...(tempChartBuffer ? [{
          filename: 'temp-spaghetti-chart.png',
          content: tempChartBuffer.toString('base64'),
          content_id: 'temp-spaghetti-chart',
        }] : []),
        ...waterLevelCharts.map(c => ({
          filename: `${c.cid}.png`,
          content: c.buffer.toString('base64'),
          content_id: c.cid,
        })),
        ...(spreadChart ? [{
          filename: `${spreadChart.cid}.png`,
          content: spreadChart.buffer.toString('base64'),
          content_id: spreadChart.cid,
        }] : []),
      ],
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
