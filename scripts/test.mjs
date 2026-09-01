// Regression tests for the pure data logic in notify.mjs.
//
//   npm test   (or: node scripts/test.mjs)
//
// No network, no canvas rendering — just the arithmetic that has bitten before:
// outlier filtering, row-vs-date lookups, day-of-year pooling, and the DAP
// ascii parser's unit handling.

import assert from 'node:assert/strict';
import {
  filterOutliers, readingNDaysBack, median, poolAroundDay, addDays, toRecord,
  mergeWithLevelCache, parseMurAscii, computeNextWeekTempForecast,
} from '../notify.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

const series = (vals) => vals.map((v, i) => ({ date: addDays('2026-08-01', i), value: v }));

// ── filterOutliers ──

test('interior spike is removed without taking its neighbours', () => {
  const out = filterOutliers(series([225.30, 226.50, 225.31, 225.32]));
  assert.deepEqual(out.map(d => d.value), [225.30, 225.31, 225.32]);
});

test('spike on the newest reading is removed', () => {
  const out = filterOutliers(series([225.30, 225.31, 225.30, 226.90]));
  assert.deepEqual(out.map(d => d.value), [225.30, 225.31, 225.30]);
});

test('spike on the oldest reading is removed', () => {
  const out = filterOutliers(series([226.90, 225.31, 225.30, 225.32]));
  assert.deepEqual(out.map(d => d.value), [225.31, 225.30, 225.32]);
});

test('a steady flood-rate rise passes untouched', () => {
  const rise = series(Array.from({ length: 20 }, (_, i) => 225.0 + i * 0.08));
  assert.equal(filterOutliers(rise).length, 20);
});

test('short series returned as-is', () => {
  const s = series([1, 99, 1]);
  assert.equal(filterOutliers(s), s);
});

// ── readingNDaysBack ──

test('finds the reading n calendar days back, not n rows back', () => {
  const days = [...series([1, 2, 3]),
    ...[10, 11, 12].map((v, i) => ({ date: addDays('2026-08-20', i), value: v }))];
  const back7 = readingNDaysBack(days, 7); // latest 2026-08-22, target 08-15 — nothing near
  assert.equal(back7, null);
  const back2 = readingNDaysBack(days, 2);
  assert.equal(back2.date, '2026-08-20');
});

test('tolerance picks the nearest reading within range', () => {
  const days = [{ date: '2026-08-10', value: 5 }, { date: '2026-08-18', value: 9 }];
  assert.equal(readingNDaysBack(days, 7).date, '2026-08-10'); // 8 days back, tolerance 3
  assert.equal(readingNDaysBack(days, 7, 0), null);
});

// ── median / pooling ──

test('median of even and odd counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('poolAroundDay wraps across the Dec/Jan boundary', () => {
  const records = [
    toRecord('2020-12-30', 1), toRecord('2021-01-02', 2), toRecord('2022-07-01', 3),
  ];
  const pool = poolAroundDay(records, 366, 3, 2026); // around Dec 31/Jan 1
  assert.deepEqual(pool.map(r => r.tempC).sort(), [1, 2]);
});

test('poolAroundDay excludes the given year', () => {
  const records = [toRecord('2025-06-01', 1), toRecord('2026-06-01', 2)];
  const pool = poolAroundDay(records, toRecord('2026-06-01', 0).dayOfYear, 0, 2026);
  assert.deepEqual(pool.map(r => r.tempC), [1]);
});

// ── mergeWithLevelCache ──

test('fresh values overwrite, cache is capped, series comes back sorted', () => {
  const cache = { 'level:X': { '2026-08-01': 1.0 } };
  const merged = mergeWithLevelCache(cache, 'level:X', [
    { date: '2026-08-01', value: 2.0 }, { date: '2026-07-31', value: 0.5 },
  ]);
  assert.deepEqual(merged, [
    { date: '2026-07-31', value: 0.5 }, { date: '2026-08-01', value: 2.0 },
  ]);
});

// ── parseMurAscii unit handling ──

test('packed short is unscaled to °C', () => {
  // 21.5°C -> K: 294.65; packed = (294.65 - 298.15) / 0.001 = -3500
  assert.ok(Math.abs(parseMurAscii('[0][13500][10039], -3500') - 21.5) < 1e-9);
});

test('kelvin float is converted, celsius float passes through', () => {
  assert.ok(Math.abs(parseMurAscii('[0][13500], 294.65') - 21.5) < 1e-9);
  assert.equal(parseMurAscii('[0][13500], 21.5'), 21.5);
});

test('fill value and garbage are rejected', () => {
  assert.equal(parseMurAscii('[0][13500], -32768'), null);
  assert.equal(parseMurAscii('no data here'), null);
});

// ── computeNextWeekTempForecast ──

test('forecast reflects the historical week-over-week delta', () => {
  // Two prior years where the water always warms 1°C across the anchor→+7 gap
  const records = [];
  for (const year of [2024, 2025]) {
    for (let d = 0; d <= 14; d++) {
      records.push(toRecord(addDays(`${year}-07-01`, d), 20 + (d >= 7 ? 1 : 0)));
    }
  }
  const f = computeNextWeekTempForecast(records, '2026-07-03', 21.0);
  assert.ok(f, 'expected a forecast');
  assert.equal(f.direction, 'warm');
  assert.ok(Math.abs(f.expectedChange - 1) < 0.35, `expectedChange ${f.expectedChange}`);
  assert.equal(f.yearsUsed, 2);
});

test('forecast is null with no usable history', () => {
  assert.equal(computeNextWeekTempForecast([], '2026-07-03', 21.0), null);
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES ABOVE' : ', 0 failed'}`);
