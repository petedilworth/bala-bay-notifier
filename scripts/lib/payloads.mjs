// Data shaping for the static site.
//
// Everything the browser needs is computed here — app.js only formats numbers
// and draws charts. Reads nothing but data/ on disk, so the build is
// deterministic and runs with no network.

import fs from 'node:fs/promises';
import {
  median, poolAroundDay, toRecord, addDays, daysBetween, readingNDaysBack,
  computeTodayTempStats, computeNextWeekTempForecast,
  STATION, EXTRA_STATIONS, FLOW_STATIONS, CM_PER_INCH,
  TEMP_CSV_PATH, LEVEL_CACHE_PATH,
} from '../../notify.mjs';

export const LEVEL_STATIONS = [
  { id: STATION, name: 'Bala', label: 'Lake Muskoka' },
  ...EXTRA_STATIONS,
];

// ── loading ──

export async function loadTemps() {
  const csv = await fs.readFile(TEMP_CSV_PATH, 'utf8');
  return csv.trim().split('\n').slice(1).map(line => {
    const [date, t] = line.split(',');
    return toRecord(date, parseFloat(t));
  }).filter(r => !isNaN(r.tempC));
}

export async function loadLevelCache() {
  return JSON.parse(await fs.readFile(LEVEL_CACHE_PATH, 'utf8'));
}

export function seriesFrom(cache, key) {
  return Object.entries(cache[key] ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
}

// ── shared stats ──

const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);

export function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function distribution(values) {
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0] ?? null, p25: quantile(s, 0.25), p50: quantile(s, 0.5),
    p75: quantile(s, 0.75), max: s[s.length - 1] ?? null, n: s.length,
  };
}

// Where `value` sits within `values`, 0-100. Reported as a plain percentile
// with no "higher is better" inversion — for lake level and water temperature
// neither direction is good or bad, so the spec's direction-normalising would
// only invent a judgement the data doesn't support.
export function percentileOf(values, value) {
  if (values.length === 0 || value === null || value === undefined) return null;
  const below = values.filter(v => v < value).length;
  const equal = values.filter(v => v === value).length;
  return Math.round(((below + equal / 2) / values.length) * 100);
}

// Mean of the readings within `n` days of the series end, by date not by row.
function trailingMean(days, n) {
  if (days.length === 0) return null;
  const cutoff = addDays(days[days.length - 1].date, -(n - 1));
  const window = days.filter(d => d.date >= cutoff);
  if (window.length === 0) return null;
  return window.reduce((a, d) => a + d.value, 0) / window.length;
}

// ── temperature ──

// Per-day-of-year envelope across every year but the current one. This is the
// climatology the current year is read against, and it replaces shipping all
// 8,800 readings: 366 rows instead of 25 years of dailies.
export function climatology(records, currentYear) {
  const buckets = new Map();
  for (const r of records) {
    if (r.year === currentYear) continue;
    if (!buckets.has(r.dayOfYear)) buckets.set(r.dayOfYear, []);
    buckets.get(r.dayOfYear).push(r.tempC);
  }
  const rows = [];
  for (let day = 1; day <= 366; day++) {
    // ±3 days, matching computeTodayTempStats, so a single noisy satellite
    // reading can't put a notch in the envelope
    const pool = [];
    for (let d = -3; d <= 3; d++) {
      const k = ((day - 1 + d + 366) % 366) + 1;
      const b = buckets.get(k);
      if (b) pool.push(...b);
    }
    if (pool.length === 0) { rows.push([day, null, null, null, null, null]); continue; }
    const s = pool.sort((a, b) => a - b);
    rows.push([day, r1(s[0]), r1(quantile(s, 0.25)), r1(quantile(s, 0.5)),
      r1(quantile(s, 0.75)), r1(s[s.length - 1])]);
  }
  return rows;
}

export function buildTemperaturePayload(records, currentYear, todayIso) {
  const byYear = new Map();
  for (const r of records) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r);
  }
  const latest = records[records.length - 1];
  const years = [...byYear.keys()].sort((a, b) => a - b);

  const recent = (year) => (byYear.get(year) ?? [])
    .sort((a, b) => a.dayOfYear - b.dayOfYear)
    .map(r => [r.dayOfYear, r1(r.tempC)]);

  const stats = computeTodayTempStats(records, latest.date, latest.tempC);
  const forecast = computeNextWeekTempForecast(records, latest.date, latest.tempC);

  // Same ±3-day pool the ranking uses, so the percentile and the rank describe
  // the same set of readings
  const pool = poolAroundDay(records, latest.dayOfYear, 3, currentYear).map(r => r.tempC);

  // Anomaly of each current-year day against the climatology median
  const clim = climatology(records, currentYear);
  const climMedian = new Map(clim.map(([day, , , p50]) => [day, p50]));
  const anomaly = (byYear.get(currentYear) ?? [])
    .sort((a, b) => a.dayOfYear - b.dayOfYear)
    .map(r => {
      const base = climMedian.get(r.dayOfYear);
      return [r.dayOfYear, base === null || base === undefined ? null : r1(r.tempC - base)];
    });

  const yearMeans = years.map(y => {
    const vals = byYear.get(y).map(r => r.tempC);
    return [y, r1(vals.reduce((a, b) => a + b, 0) / vals.length), vals.length];
  });

  return {
    meta: {
      key: 'water_temp', label: 'Water temperature', unit: '°C', format: 'f1',
      source: 'NOAA MUR SST v4.1 (satellite)',
      firstDate: records[0].date, lastDate: latest.date,
      years: years.length, records: records.length,
      // The satellite product lags a couple of days; every reading here is
      // labelled by its own date so the page never implies it is live.
      lagDays: daysBetween(todayIso, latest.date),
    },
    latest: { date: latest.date, dayOfYear: latest.dayOfYear, value: r1(latest.tempC) },
    current: { year: currentYear, series: recent(currentYear) },
    previous: { year: currentYear - 1, series: recent(currentYear - 1) },
    climatology: clim,
    anomaly,
    stats: stats && {
      min: r1(stats.min), max: r1(stats.max), median: r1(stats.median),
      rank: stats.rank, totalYears: stats.totalYears,
      windowStart: stats.windowStart, windowEnd: stats.windowEnd,
      earliestYear: stats.earliestYear, latestYear: stats.latestYear,
      percentile: percentileOf(pool, latest.tempC),
    },
    forecast: forecast && {
      expectedChange: r1(forecast.expectedChange), direction: forecast.direction,
      yearsUsed: forecast.yearsUsed, futureDate: forecast.futureDate,
    },
    dist: (() => { const d = distribution(pool); return { ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'n' ? v : r1(v)])) }; })(),
    yearMeans,
  };
}

// Every year at full resolution — the year-over-year overlay. Split into its
// own file (~170 KB) and fetched only when the reader asks for it, so the
// temperature page itself stays small.
export function buildAllYearsPayload(records, currentYear) {
  const byYear = new Map();
  for (const r of records) {
    if (!byYear.has(r.year)) byYear.set(r.year, []);
    byYear.get(r.year).push(r);
  }
  return {
    meta: { currentYear, years: [...byYear.keys()].sort((a, b) => a - b) },
    series: [...byYear.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, rs]) => [year, rs.sort((a, b) => a.dayOfYear - b.dayOfYear)
        .map(r => [r.dayOfYear, r1(r.tempC)])]),
  };
}

// ── levels and flow ──

function julyAverage(days) {
  const july = days.filter(d => d.date.substring(5, 7) === '07').map(d => d.value);
  if (july.length === 0) return null;
  return july.reduce((a, b) => a + b, 0) / july.length;
}

function stationBlock(st, days, { unit, format, decimals }) {
  const latest = days[days.length - 1];
  const values = days.map(d => d.value);
  const avg = julyAverage(days);
  const back = (n) => {
    const p = readingNDaysBack(days, n, 2);
    return p ? { date: p.date, change: (latest.value - p.value) } : null;
  };
  return {
    id: st.id, name: st.name, label: st.label, unit, format, decimals,
    latest: { date: latest.date, value: r3(latest.value) },
    julyAvg: r3(avg),
    // Inches relative to the station's own July mean. The five level gauges sit
    // on different datums (Bala is ~225 m above sea level, the rest are 0-10 m
    // local), so this is the ONLY quantity comparable across stations.
    vsJulyIn: avg === null ? null : r1((latest.value - avg) * 100 / CM_PER_INCH),
    trailing: { d7: r3(trailingMean(days, 7)), d30: r3(trailingMean(days, 30)) },
    changes: { d1: back(1), d7: back(7), d30: back(30) },
    dist: Object.fromEntries(Object.entries(distribution(values)).map(([k, v]) => [k, k === 'n' ? v : r3(v)])),
    percentile: percentileOf(values, latest.value),
    firstDate: days[0].date, lastDate: latest.date, n: days.length,
    series: days.map(d => [d.date, r3(d.value)]),
  };
}

export function buildLevelsPayload(cache, todayIso) {
  const stations = [];
  for (const st of LEVEL_STATIONS) {
    const days = seriesFrom(cache, `level:${st.id}`);
    if (days.length === 0) continue;
    stations.push(stationBlock(st, days, { unit: 'm', format: 'f3', decimals: 3 }));
  }
  // Normalised comparison: inches from each station's own July mean, on the
  // dates every station has in common.
  const withAvg = stations.filter(s => s.julyAvg !== null);
  const maps = withAvg.map(s => new Map(s.series));
  const commonDates = withAvg.length === 0 ? [] :
    [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  const comparison = {
    stations: withAvg.map(s => ({ id: s.id, name: s.name })),
    series: commonDates.map(date => [
      date,
      ...withAvg.map((s, i) => r1((maps[i].get(date) - s.julyAvg) * 100 / CM_PER_INCH)),
    ]),
  };
  return { meta: { generated: todayIso, unit: 'm' }, stations, comparison };
}

export function buildFlowPayload(cache, todayIso) {
  const stations = [];
  const omitted = [];
  for (const st of FLOW_STATIONS) {
    const days = seriesFrom(cache, `flow:${st.id}`);
    // A gauge can go dormant and leave only old readings behind (02EB006
    // stopped reporting in 2021); showing its last value as current would be
    // wrong by four years.
    const fresh = days.length > 0 && daysBetween(todayIso, days[days.length - 1].date) <= 90;
    if (!fresh) {
      if (days.length > 0) omitted.push({ id: st.id, name: st.name, lastDate: days[days.length - 1].date });
      continue;
    }
    stations.push(stationBlock(st, days, { unit: 'm³/s', format: 'f1', decimals: 1 }));
  }
  return { meta: { generated: todayIso, unit: 'm³/s' }, stations, omitted };
}

// Trailing window by calendar date, not by row. Slicing the last N rows spans
// any gap in the record and silently relabels it — the Bala series still holds
// a 158-day hole, so `slice(-90)` reached back to December and drew a straight
// line across five missing months.
export function windowByDate(rows, days) {
  if (rows.length === 0) return rows;
  const cutoff = addDays(rows[rows.length - 1][0], -(days - 1));
  return rows.filter(r => r[0] >= cutoff);
}

export function buildOverviewPayload(temp, levels, flow, todayIso) {
  const bala = levels.stations.find(s => s.id === STATION) ?? levels.stations[0];
  return {
    meta: { generated: todayIso },
    level: bala && {
      name: bala.name, label: bala.label, date: bala.latest.date,
      value: bala.latest.value, unit: 'm', vsJulyIn: bala.vsJulyIn,
      percentile: bala.percentile, dist: bala.dist,
      trailing: bala.trailing, changes: bala.changes,
      ageDays: daysBetween(todayIso, bala.latest.date),
      series: windowByDate(bala.series, 90),
    },
    temp: {
      date: temp.latest.date, value: temp.latest.value, unit: '°C',
      tempF: Math.round(temp.latest.value * 9 / 5 + 32),
      stats: temp.stats, forecast: temp.forecast, dist: temp.dist,
      ageDays: temp.meta.lagDays, years: temp.meta.years,
    },
    flow: flow.stations.map(s => ({
      id: s.id, name: s.name, label: s.label,
      date: s.latest.date, value: s.latest.value, percentile: s.percentile,
    })),
  };
}
