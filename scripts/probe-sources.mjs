// Discovery probe for prospective data sources.
//
//   node scripts/probe-sources.mjs          (or the "Probe data sources" Action)
//
// This writes nothing and touches no production path. It exists because the
// development sandbox's egress proxy blocks every third-party host, so the
// shape of these APIs cannot be observed while writing code against them. A
// parser written against a guessed response is code that looks finished and has
// never run — so this reports what is actually served, and the integration gets
// designed afterwards.
//
// Checks robots.txt before fetching anything else from a host, and reports
// rather than assumes.

const TIMEOUT_MS = 20000;

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function get(url, opts = {}) {
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeout ?? TIMEOUT_MS),
      headers: {
        // Identify honestly rather than impersonating a browser.
        'User-Agent': 'muskoka-tracker-probe/1.0 (+https://github.com/petedilworth/muskoka-tracker)',
        ...(opts.headers || {}),
      },
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, url: resp.url, text, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, ms: Date.now() - started };
  }
}

function head(title) {
  console.log(`\n${'─'.repeat(70)}\n${title}\n${'─'.repeat(70)}`);
}

// Report what robots.txt says about a path without pretending to be a full
// parser — the point is to surface the rules for a human to read.
async function robots(origin, path) {
  const r = await get(`${origin}/robots.txt`);
  if (!r.ok) {
    console.log(`  robots.txt: ${bad(`HTTP ${r.status || r.error}`)} — treat as unknown, do not crawl`);
    return;
  }
  const lines = r.text.split('\n').map(l => l.trim()).filter(Boolean);
  const disallows = lines.filter(l => /^disallow:/i.test(l));
  console.log(`  robots.txt: ${ok('found')}, ${lines.length} lines, ${disallows.length} Disallow rules`);
  const relevant = disallows.filter(l => {
    const p = l.split(':')[1]?.trim();
    return p && (p === '/' || path.startsWith(p));
  });
  console.log(relevant.length
    ? `  ${bad('DISALLOWED')} for ${path}: ${relevant.join(' | ')}`
    : `  ${ok('no rule blocks')} ${path}`);
  const crawlDelay = lines.find(l => /^crawl-delay:/i.test(l));
  if (crawlDelay) console.log(`  ${crawlDelay}`);
}

// ── OPG: dam operations for the Bala reach ──

async function probeOpg() {
  head('OPG — water.opg.com (Bala reach dam operations)');
  const origin = 'https://water.opg.com';
  await robots(origin, '/sites/bala-reach/');

  const page = await get(`${origin}/sites/bala-reach/`);
  if (!page.ok) {
    console.log(`  page: ${bad(`HTTP ${page.status || page.error}`)} — thread closes here`);
    return;
  }
  console.log(`  page: ${ok('HTTP 200')}, ${(page.text.length / 1024).toFixed(0)} KB in ${page.ms}ms`);

  // Server-rendered numbers, or a JS shell that fetches them separately?
  const hasTable = /<table/i.test(page.text);
  const numbers = (page.text.match(/\d+\.\d{1,3}\s*(m³\/s|cms|m\b)/gi) || []).slice(0, 6);
  console.log(`  server-rendered table: ${hasTable ? ok('yes') : dim('no')}`);
  console.log(`  numeric readings visible in HTML: ${numbers.length ? ok(numbers.join(', ')) : dim('none')}`);

  // Candidate data endpoints referenced by the page or its scripts
  const urls = [...new Set(
    (page.text.match(/["'`]([^"'`]*\/(?:api|data|json|feed|graph)[^"'`]*)["'`]/gi) || [])
      .map(m => m.slice(1, -1)).filter(u => u.length < 200)
  )].slice(0, 15);
  console.log(`  candidate data endpoints (${urls.length}):`);
  for (const u of urls) console.log(`    ${u}`);

  const embedded = page.text.match(/(?:window\.\w+|var \w+)\s*=\s*(\{.{0,120}|\[.{0,120})/g) || [];
  console.log(`  embedded JS data blobs: ${embedded.length ? ok(String(embedded.length)) : dim('none')}`);
  if (embedded.length) console.log(`    e.g. ${embedded[0].replace(/\s+/g, ' ').slice(0, 110)}…`);

  console.log(dim('  → if this is a JS shell with no visible endpoint, the thread needs'));
  console.log(dim('    a browser-rendered probe or should stop at the About explainer.'));
}

// ── DataStream: Muskoka water quality ──
//
// Queries below follow datastreamapp/api-docs (docs/README.md) rather than
// guesswork. Three things there matter and are easy to get wrong:
//
//   1. contains() is NOT supported. It appears in the docs only inside an HTML
//      comment. The operators are in, eq, lt, gt, lte, gte, ne — so a location
//      cannot be found by name substring, and the documented way to select an
//      area is a lat/long bounding box.
//   2. The location name field is `Name`, not `LocationName`.
//   3. Attribution is mandatory: any published use needs the citation, licence
//      and a link to https://doi.org/{DOI}, all of which come from /Metadata.
//      So /Metadata is probed first, not as an afterthought.

// Muskoka lakes, centred on the Bala coordinates already used for the satellite
// temperature lookup (45.01 N, -79.6 W). Wide enough to take in Lake Muskoka,
// Lake Rosseau and Lake Joseph.
const MUSKOKA_BOX = {
  latMin: '44.85', latMax: '45.40',
  lonMin: '-79.95', lonMax: '-79.15',
};

// The docs ask for 2 requests/second and no parallelism, on pain of 429.
const DS_GAP_MS = 600;
const pause = (ms) => new Promise(r => setTimeout(r, ms));

function summarise(rows, fields, limit = 8) {
  for (const r of rows.slice(0, limit)) {
    console.log('    ' + fields.map(f => r[f] ?? '—').join(' · '));
  }
  if (rows.length > limit) console.log(dim(`    …and ${rows.length - limit} more`));
  if (rows[0]) console.log(dim(`    fields present: ${Object.keys(rows[0]).join(', ')}`));
}

async function dsGet(url, headers, label) {
  const r = await get(url, { headers });
  const status = r.ok ? ok(`HTTP ${r.status}`) : bad(`HTTP ${r.status || r.error}`);
  console.log(`  ${label}: ${status} in ${r.ms}ms`);
  if (r.status === 429) console.log(`  ${bad('rate limited')} — the probe is pacing at ${DS_GAP_MS}ms; slow it further`);
  await pause(DS_GAP_MS);
  if (!r.ok) {
    if (r.text) console.log(dim(`    body: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`));
    return null;
  }
  try {
    const j = JSON.parse(r.text);
    if (j['@odata.nextLink']) console.log(dim('    more pages available (@odata.nextLink present)'));
    return j;
  } catch {
    console.log(dim(`    not JSON: ${r.text.slice(0, 200).replace(/\s+/g, ' ')}`));
    return null;
  }
}

async function probeDataStream() {
  head('DataStream — Muskoka water quality');
  const key = process.env.DATASTREAM_API_KEY;
  // The QA host lets a query be shaken out without touching production.
  const base = process.env.DATASTREAM_QA
    ? 'https://api.qa.datastream.org/v1/odata/v4'
    : 'https://api.datastream.org/v1/odata/v4';
  console.log(`  host: ${base}`);
  console.log(`  API key in env: ${key ? ok('yes') : dim('no — expect 401')}`);
  if (!key) {
    console.log(dim('  Request one via the "Request an API Key" form linked from'));
    console.log(dim('  github.com/datastreamapp/api-docs, then set DATASTREAM_API_KEY.'));
  }
  const headers = key ? { 'x-api-key': key } : {};

  const box = `Latitude gt '${MUSKOKA_BOX.latMin}' and Latitude lt '${MUSKOKA_BOX.latMax}'`
    + ` and Longitude gt '${MUSKOKA_BOX.lonMin}' and Longitude lt '${MUSKOKA_BOX.lonMax}'`;
  console.log(dim(`  bounding box: ${box}`));

  // 1. Which datasets cover this area, and under what licence?
  const meta = await dsGet(
    `${base}/Metadata?$filter=${encodeURIComponent(box)}`
    + `&$select=${encodeURIComponent('DOI,DatasetName,DataCollectionOrganization,Citation,Licence,TemporalExtent')}`
    + '&$top=25',
    headers, 'Metadata (datasets covering Muskoka)');
  if (meta) {
    const rows = meta.value || [];
    console.log(`    ${rows.length} dataset(s)`);
    for (const r of rows) {
      console.log(`    ${r.DatasetName ?? '—'}`);
      console.log(dim(`      DOI ${r.DOI ?? '—'} · ${r.DataCollectionOrganization ?? '—'} · extent ${JSON.stringify(r.TemporalExtent ?? null)}`));
      if (r.Licence) console.log(dim(`      licence: ${String(r.Licence).slice(0, 120)}`));
    }
    if (rows[0]) console.log(dim(`    fields present: ${Object.keys(rows[0]).join(', ')}`));
  }

  // 2. Which monitoring locations sit inside the box?
  const locs = await dsGet(
    `${base}/Locations?$filter=${encodeURIComponent(box)}`
    + `&$select=${encodeURIComponent('Id,DOI,Name,Latitude,Longitude,MonitoringLocationType')}`
    + '&$top=50',
    headers, 'Locations (inside the box)');
  let sampleLocationId = null;
  if (locs) {
    const rows = locs.value || [];
    console.log(`    ${rows.length} location(s)`);
    summarise(rows, ['Id', 'Name', 'MonitoringLocationType', 'Latitude', 'Longitude'], 12);
    sampleLocationId = rows[0]?.Id ?? null;
  }

  // 3. What is actually measured at one of them, and over what period?
  if (sampleLocationId !== null) {
    const obs = await dsGet(
      `${base}/Observations?$filter=${encodeURIComponent(`LocationId eq '${sampleLocationId}'`)}`
      + `&$select=${encodeURIComponent('CharacteristicName,ResultValue,ResultUnit,ActivityStartDate,ActivityDepthHeightMeasure')}`
      + '&$top=200',
      headers, `Observations at location ${sampleLocationId}`);
    if (obs) {
      const rows = obs.value || [];
      const byChar = new Map();
      for (const r of rows) {
        const k = `${r.CharacteristicName} (${r.ResultUnit ?? 'no unit'})`;
        if (!byChar.has(k)) byChar.set(k, []);
        byChar.get(k).push(r.ActivityStartDate);
      }
      console.log(`    ${rows.length} observations across ${byChar.size} characteristic(s)`);
      for (const [k, dates] of byChar) {
        const sorted = dates.filter(Boolean).sort();
        console.log(`      ${k}: ${dates.length} readings, ${sorted[0] ?? '?'} → ${sorted[sorted.length - 1] ?? '?'}`);
      }
      if (rows[0]) console.log(dim(`    fields present: ${Object.keys(rows[0]).join(', ')}`));
    }
  } else {
    console.log(dim('  no location id available, so the Observations shape stays unknown'));
  }
}

// ── Environment Canada: can the missing spring be had another way? ──
//
// The archive holds nothing between Jan 2026 and Jun 2026 because the
// daily-mean series publishes on a long lag and this project only started
// caching realtime readings in June. Three MSC GeoMet collections the project
// has never called might carry the current year sooner. All three draw on
// HYDAT, so they may lag identically — worth confirming rather than assuming.

const EC_BASE = 'https://api.weather.gc.ca/collections';
const EC_STATION = '02EB015';

async function probeEnvironmentCanada() {
  head('Environment Canada — collections not yet used (can we get spring 2026?)');

  for (const coll of ['hydrometric-annual-peaks', 'hydrometric-annual-statistics', 'hydrometric-monthly-mean']) {
    const url = `${EC_BASE}/${coll}/items?f=json&STATION_NUMBER=${EC_STATION}&limit=500`;
    const r = await get(url);
    if (!r.ok) {
      console.log(`  ${coll}: ${bad(`HTTP ${r.status || r.error}`)}`);
      continue;
    }
    try {
      const feats = JSON.parse(r.text).features || [];
      // Year lives under different property names across these collections, so
      // look for whichever is present rather than assuming one.
      const years = feats.map(f => {
        const p = f.properties || {};
        return p.YEAR ?? p.DATE?.substring(0, 4) ?? p.MONTH?.substring(0, 4) ?? null;
      }).filter(Boolean).map(Number).filter(Number.isFinite);
      const uniq = [...new Set(years)].sort((a, b) => a - b);
      const newest = uniq[uniq.length - 1];
      console.log(`  ${coll}: ${ok(`HTTP 200`)}, ${feats.length} features`);
      console.log(`    years present: ${uniq.length ? `${uniq[0]}–${newest}` : dim('none parsed')}`);
      console.log(`    has 2026: ${uniq.includes(2026) ? ok('YES — this fills the gap') : bad('no')}`);
      if (feats[0]) console.log(dim(`    properties: ${Object.keys(feats[0].properties || {}).join(', ')}`));
    } catch (e) {
      console.log(`  ${coll}: ${dim('unparseable: ' + e.message)}`);
    }
    await pause(300);
  }

  // The Water Office publishes per-station realtime archives separately from
  // the OGC API. Check the rules before considering it, same as for OPG.
  head('Water Office — historical realtime downloads');
  await robots('https://wateroffice.ec.gc.ca', '/download/');
  console.log(dim('  Reported only. No fetching here until the rules above are read.'));
}

// A sandbox egress proxy also answers 403, which looks identical to a service
// refusing us. Check a host that is certainly reachable and certainly public
// first, so a blocked environment is reported as such instead of being
// misread as "the API needs a key".
async function egressWorks() {
  const r = await get('https://api.weather.gc.ca/collections?f=json', { timeout: 10000 });
  return r.ok;
}

async function main() {
  console.log('Probing prospective data sources. Writes nothing; reports only.');
  console.log(dim(`Run at ${new Date().toISOString()}`));

  if (!await egressWorks()) {
    console.log(`\n${bad('This environment cannot reach the open internet.')}`);
    console.log('A control request to api.weather.gc.ca — public, no auth — also failed,');
    console.log('so every 403 below is this network, not the service. Run the');
    console.log('"Probe data sources" Action on a GitHub runner instead.');
  }

  await probeEnvironmentCanada();
  await probeOpg();
  await probeDataStream();
  console.log(`\n${'─'.repeat(70)}`);
  console.log('Done. Design the integration against what is printed above,');
  console.log('not against what the API was assumed to return.');
}

main().catch(e => { console.error('Probe failed:', e); process.exit(1); });
