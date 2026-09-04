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

async function probeDataStream() {
  head('DataStream — api.datastream.org (Lake Partner / Muskoka Lake System Health)');
  const key = process.env.DATASTREAM_API_KEY;
  console.log(`  API key in env: ${key ? ok('yes') : dim('no — testing unauthenticated')}`);
  const headers = key ? { 'x-api-key': key } : {};
  const base = 'https://api.datastream.org/v1/odata/v4';

  const root = await get(base, { headers });
  console.log(`  service root: ${root.ok ? ok(`HTTP ${root.status}`) : bad(`HTTP ${root.status || root.error}`)} in ${root.ms}ms`);
  if (root.ok) {
    try {
      const j = JSON.parse(root.text);
      const names = (j.value || []).map(v => v.name || v.url).filter(Boolean);
      console.log(`  entity sets: ${names.length ? ok(names.join(', ')) : dim('none listed')}`);
    } catch {
      console.log(`  ${dim('root is not JSON:')} ${root.text.slice(0, 160).replace(/\s+/g, ' ')}`);
    }
  } else if (root.status === 401 || root.status === 403) {
    console.log(`  ${bad('authentication required')} — sign up at datastream.org for a free key,`);
    console.log(`  ${bad('then add it as the DATASTREAM_API_KEY secret and re-run.')}`);
    return;
  }

  // Which Muskoka lakes are monitored, and by which programme?
  const q = `${base}/Locations?$filter=contains(LocationName,'Muskoka')&$top=10`;
  const locs = await get(q, { headers });
  console.log(`  Muskoka locations query: ${locs.ok ? ok(`HTTP ${locs.status}`) : bad(`HTTP ${locs.status || locs.error}`)}`);
  if (locs.ok) {
    try {
      const j = JSON.parse(locs.text);
      const rows = j.value || [];
      console.log(`  matched ${rows.length} locations`);
      for (const r of rows.slice(0, 8)) {
        console.log(`    ${r.LocationId ?? '?'} · ${r.LocationName ?? '?'} · ${r.DatasetName ?? r.DOI ?? ''}`);
      }
      if (rows[0]) {
        console.log(dim(`  field names on a Location: ${Object.keys(rows[0]).join(', ')}`));
      }
    } catch {
      console.log(`  ${dim('response head:')} ${locs.text.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
  }
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

  await probeOpg();
  await probeDataStream();
  console.log(`\n${'─'.repeat(70)}`);
  console.log('Done. Design the integration against what is printed above,');
  console.log('not against what the API was assumed to return.');
}

main().catch(e => { console.error('Probe failed:', e); process.exit(1); });
