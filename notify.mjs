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
const JULY_YEARS = [2021, 2022, 2023, 2024, 2025];

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

// ── Main ──

async function main() {
  console.log('🌊 Bala Bay Daily Water Level Notification');
  console.log('──────────────────────────────────────────');

  // Validate config
  if (!RESEND_API_KEY) throw new Error('Missing RESEND_API_KEY');
  if (EMAIL_TO.length === 0) throw new Error('Missing EMAIL_TO');

  // 1. Fetch recent realtime data (~30 days) + daily-mean backfill for 60-day chart
  console.log('Fetching realtime data...');
  const rtFeats = await fetchAllFeatures(
    (lim, off) => `${API_BASE}/hydrometric-realtime/items?f=json&STATION_NUMBER=${STATION}&limit=${lim}&offset=${off}`,
    20
  );
  console.log(`  ${rtFeats.length} raw readings`);
  let recentData = parseRealtimeFeatures(rtFeats);
  recentData = filterOutliers(recentData);
  console.log(`  ${recentData.length} days after averaging & cleaning`);

  if (recentData.length === 0) {
    throw new Error('No water level data available from realtime API');
  }

  // Backfill with daily-mean data to reach 60 days for the chart
  if (recentData.length < 60) {
    const earliestRt = recentData[0].date;
    const startDate = new Date(earliestRt + 'T12:00:00');
    startDate.setDate(startDate.getDate() - (60 - recentData.length + 5)); // fetch extra overlap
    const startStr = startDate.toISOString().substring(0, 10);
    console.log(`Backfilling daily-mean data from ${startStr} to ${earliestRt}...`);
    try {
      const dailyFeats = await fetchAllFeatures(
        (lim, off) => `${API_BASE}/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${STATION}&datetime=${startStr}/${earliestRt}&limit=${lim}&offset=${off}`,
        2
      );
      const dailyData = parseDailyFeatures(dailyFeats);
      console.log(`  ${dailyData.length} daily-mean days fetched`);
      // Merge: daily-mean for dates not already in recentData
      const existingDates = new Set(recentData.map(d => d.date));
      const backfill = dailyData.filter(d => !existingDates.has(d.date));
      recentData = [...backfill, ...recentData].sort((a, b) => a.date.localeCompare(b.date));
      console.log(`  ${recentData.length} total days after backfill`);
    } catch (e) {
      console.log(`  Daily-mean backfill failed: ${e.message} (continuing with realtime only)`);
    }
  }

  const latest = recentData[recentData.length - 1];
  console.log(`  Latest: ${latest.date} = ${latest.value.toFixed(3)}m`);

  // 2. Compute trend (7-day change if available)
  let trend = null;
  let trendArrow = '';
  if (recentData.length >= 7) {
    const weekAgo = recentData[recentData.length - 7];
    trend = (latest.value - weekAgo.value) * 100; // in cm
    trendArrow = trend > 0.5 ? '↗ rising' : trend < -0.5 ? '↘ falling' : '→ stable';
    console.log(`  7-day trend: ${trend > 0 ? '+' : ''}${trend.toFixed(1)}cm (${trendArrow})`);
  }

  // 3. Compute 5-year July average
  console.log('Fetching July averages...');
  let julyVals = [];
  for (const yr of JULY_YEARS) {
    try {
      const feats = await fetchAllFeatures(
        (lim, off) => `${API_BASE}/hydrometric-daily-mean/items?f=json&STATION_NUMBER=${STATION}&datetime=${yr}-07-01/${yr}-07-31&limit=${lim}&offset=${off}`,
        1
      );
      const parsed = parseDailyFeatures(feats);
      console.log(`  July ${yr}: ${parsed.length} days`);
      for (const d of parsed) julyVals.push(d.value);
    } catch (e) {
      console.log(`  July ${yr}: unavailable`);
    }
  }

  let julyAvg = null;
  let deltaCm = null;
  let deltaSign = '';
  let deltaNote = '';

  if (julyVals.length > 0) {
    julyAvg = julyVals.reduce((a, b) => a + b, 0) / julyVals.length;
    deltaCm = (latest.value - julyAvg) * 100;
    deltaSign = deltaCm >= 0 ? '+' : '';
    deltaNote = deltaCm > 10 ? 'Above normal summer level'
      : deltaCm < -10 ? 'Below normal summer level'
      : deltaCm > 0 ? 'Slightly above normal'
      : deltaCm < 0 ? 'Slightly below normal'
      : 'At normal summer level';
    console.log(`  July avg: ${julyAvg.toFixed(3)}m | Delta: ${deltaSign}${deltaCm.toFixed(1)}cm`);
  }

  // 4. Fetch water temperature (satellite SST)
  console.log('Fetching water temperature...');
  const waterTemp = await fetchWaterTemp();
  if (waterTemp) {
    console.log(`  Water temp: ${waterTemp.tempC}°C (${(waterTemp.tempC * 9/5 + 32).toFixed(0)}°F) — ${waterTemp.date}`);
  } else {
    console.log('  Water temperature unavailable');
  }

  // 5. Build and send email
  console.log('Sending email...');

  const dateStr = new Date(latest.date + 'T12:00:00').toLocaleDateString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  // Chart: last 60 days as a detailed bar chart with labels
  const chartDays = recentData.slice(-60);
  const minVal = Math.min(...chartDays.map(d => d.value));
  const maxVal = Math.max(...chartDays.map(d => d.value));
  const range = maxVal - minVal || 0.01;
  const chartHeight = 120; // px

  const chartBars = chartDays.map((d, i) => {
    const pct = (d.value - minVal) / range;
    const height = Math.max(3, Math.round(pct * (chartHeight - 10) + 3));
    // Highlight the most recent day
    const color = i === chartDays.length - 1 ? '#E07B4C' : '#4A9BD9';
    return `<td style="vertical-align:bottom;padding:0 0.5px;">
      <div style="width:6px;height:${height}px;background:${color};border-radius:1px;" title="${d.date}: ${d.value.toFixed(3)}m"></div>
    </td>`;
  }).join('');

  // Date labels: first, middle, and last
  const firstDate = chartDays[0];
  const midIdx = Math.floor(chartDays.length / 2);
  const midDate = chartDays[midIdx];
  const lastDate = chartDays[chartDays.length - 1];
  const fmtShort = (d) => { const dt = new Date(d.date + 'T12:00:00'); return dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); };

  // July average reference line position (if available)
  let refLinePct = null;
  if (julyAvg !== null && julyAvg >= minVal && julyAvg <= maxVal) {
    refLinePct = ((julyAvg - minVal) / range) * 100;
  }

  const deltaColor = deltaCm > 10 ? '#E07B4C'
    : deltaCm < -10 ? '#2D6A9F'
    : '#5BA88A';

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
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">Current Level</div>
        <div style="font-size:28px;font-weight:700;color:#0B1D33;">${latest.value.toFixed(3)}<span style="font-size:14px;color:#6B6B6B;margin-left:2px;">m</span></div>
      </div>

      ${waterTemp ? `
      <!-- Water Temperature -->
      <div style="margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">Water Temperature</div>
        <div style="font-size:28px;font-weight:700;color:#0B1D33;">${waterTemp.tempC.toFixed(1)}<span style="font-size:14px;color:#6B6B6B;margin-left:2px;">°C</span> <span style="font-size:16px;font-weight:400;color:#6B6B6B;">(${(waterTemp.tempC * 9/5 + 32).toFixed(0)}°F)</span></div>
      </div>
      ` : ''}

      ${julyAvg !== null ? `
      <!-- Delta -->
      <div style="background:#F8F6F2;border-radius:8px;padding:12px 16px;margin-bottom:16px;">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:4px;">vs 5-Year July Average</div>
        <div style="font-size:24px;font-weight:700;color:${deltaColor};">${deltaSign}${deltaCm.toFixed(1)} cm</div>
        <div style="font-size:12px;color:#6B6B6B;margin-top:2px;">${deltaNote} · July avg: ${julyAvg.toFixed(3)}m</div>
      </div>
      ` : ''}

      ${trend !== null ? `
      <!-- Trend -->
      <div style="font-size:13px;color:#6B6B6B;margin-bottom:16px;">
        <strong>7-day trend:</strong> ${trend > 0 ? '+' : ''}${trend.toFixed(1)} cm ${trendArrow}
      </div>
      ` : ''}

      <!-- Water Level Chart -->
      <div style="margin-top:12px;">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#6B6B6B;margin-bottom:8px;">Water Level — Last ${chartDays.length} Days</div>
        <div style="position:relative;">
          <!-- Y-axis labels -->
          <div style="display:inline-block;vertical-align:bottom;text-align:right;padding-right:6px;font-size:9px;color:#999;width:42px;">
            <div style="margin-bottom:${chartHeight - 18}px;">${maxVal.toFixed(2)}m</div>
            <div>${minVal.toFixed(2)}m</div>
          </div>
          <!-- Bars -->
          <div style="display:inline-block;vertical-align:bottom;position:relative;border-left:1px solid #E0DAD2;border-bottom:1px solid #E0DAD2;padding-left:2px;">
            ${refLinePct !== null ? `<div style="position:absolute;left:0;right:0;bottom:${refLinePct}%;border-top:1px dashed #5BA88A;z-index:1;"><span style="position:absolute;right:0;top:-10px;font-size:8px;color:#5BA88A;">Jul avg</span></div>` : ''}
            <table style="border-collapse:collapse;height:${chartHeight}px;"><tr>${chartBars}</tr></table>
          </div>
        </div>
        <!-- Date labels -->
        <div style="margin-left:50px;font-size:9px;color:#999;display:flex;justify-content:space-between;margin-top:2px;">
          <span>${fmtShort(firstDate)}</span>
          <span>${fmtShort(midDate)}</span>
          <span style="font-weight:600;color:#6B6B6B;">${fmtShort(lastDate)}</span>
        </div>
        <div style="margin-top:6px;font-size:9px;color:#999;">
          <span style="display:inline-block;width:8px;height:8px;background:#4A9BD9;border-radius:1px;vertical-align:middle;margin-right:3px;"></span>Daily level
          <span style="display:inline-block;width:8px;height:8px;background:#E07B4C;border-radius:1px;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>Today
          ${refLinePct !== null ? '<span style="display:inline-block;width:12px;border-top:1px dashed #5BA88A;vertical-align:middle;margin-left:8px;margin-right:3px;"></span>Jul avg' : ''}
        </div>
      </div>
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
  const text = [
    `🌊 Bala Bay Water Level — ${dateStr}`,
    ``,
    `Current: ${latest.value.toFixed(3)} m`,
    waterTemp ? `Water temp: ${waterTemp.tempC.toFixed(1)}°C (${(waterTemp.tempC * 9/5 + 32).toFixed(0)}°F)` : '',
    julyAvg !== null ? `vs July avg: ${deltaSign}${deltaCm.toFixed(1)} cm (${deltaNote})` : '',
    trend !== null ? `7-day trend: ${trend > 0 ? '+' : ''}${trend.toFixed(1)} cm ${trendArrow}` : '',
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
      subject: `🌊 Bala Bay: ${latest.value.toFixed(2)}m (${deltaSign}${deltaCm?.toFixed(1) ?? '?'}cm vs July)${waterTemp ? ` · ${waterTemp.tempC.toFixed(0)}°C` : ''}`,
      html: html,
      text: text,
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
