import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREQUENCIES, NOMINAL_PER_YEAR, applyGrowth, daysInMonthOf, elapsedMonths, expandSchedule,
  perOccurrenceFromAnnual, prorate, prorateMonth, shiftForLag, splitAcross, splitEvenly,
} from '../model/recurrence.js';
import { sumCents } from '../model/money.js';
import { toPeriod } from '../model/dates.js';
import { throwsCode } from './helpers/build.js';

const YEAR = { windowStart: '2026-01-01', windowEnd: '2026-12-31' };
const FIVE_YEARS = { windowStart: '2026-01-01', windowEnd: '2030-12-31' };

/* ---- frequencies ---- */

test('every declared frequency expands without error', () => {
  for (const frequency of FREQUENCIES) {
    const dates = expandSchedule({ start: '2026-01-15', frequency, ...YEAR });
    assert.ok(Array.isArray(dates), `${frequency} did not expand`);
    assert.ok(dates.length >= 1, `${frequency} produced nothing in a full year`);
  }
  throwsCode(() => expandSchedule({ start: '2026-01-15', frequency: 'fortnightly', ...YEAR }),
    'recurrence.bad_frequency');
});

test('once emits exactly one date', () => {
  assert.deepEqual(expandSchedule({ start: '2026-03-15', frequency: 'once', ...YEAR }), ['2026-03-15']);
  assert.deepEqual(expandSchedule({ start: '2027-03-15', frequency: 'once', ...YEAR }), [],
    'outside the window it emits nothing');
});

test('monthly, quarterly, semiannual and annual step by whole months', () => {
  assert.equal(expandSchedule({ start: '2026-01-15', frequency: 'monthly', ...YEAR }).length, 12);
  assert.deepEqual(expandSchedule({ start: '2026-01-15', frequency: 'quarterly', ...YEAR }),
    ['2026-01-15', '2026-04-15', '2026-07-15', '2026-10-15']);
  assert.deepEqual(expandSchedule({ start: '2026-01-15', frequency: 'semiannual', ...YEAR }),
    ['2026-01-15', '2026-07-15']);
  assert.deepEqual(expandSchedule({ start: '2026-01-15', frequency: 'annual', ...YEAR }), ['2026-01-15']);
});

test('weekly and biweekly anchor on the start date, not on a month', () => {
  const weekly = expandSchedule({ start: '2026-01-02', frequency: 'weekly', ...YEAR });
  assert.equal(weekly[0], '2026-01-02');
  assert.equal(weekly[1], '2026-01-09');
  assert.equal(weekly.length, 52, '2026-01-02 is a Friday; the last is 2026-12-25');
  assert.equal(weekly[weekly.length - 1], '2026-12-25');

  const biweekly = expandSchedule({ start: '2026-01-02', frequency: 'biweekly', ...YEAR });
  assert.equal(biweekly[1], '2026-01-16');
  assert.equal(biweekly.length, 26);
});

test('biweekly produces three-paycheck months, which is a real cash-flow event', () => {
  const dates = expandSchedule({ start: '2026-01-02', frequency: 'biweekly', ...YEAR });
  const perMonth = new Map();
  for (const d of dates) perMonth.set(toPeriod(d), (perMonth.get(toPeriod(d)) ?? 0) + 1);

  const threePayMonths = [...perMonth].filter(([, n]) => n === 3).map(([m]) => m);
  assert.ok(threePayMonths.length >= 2, `expected some three-paycheck months, got ${threePayMonths}`);
  assert.deepEqual(threePayMonths, ['2026-01', '2026-07'],
    'the extra paychecks land in specific months — this is why we never approximate biweekly as 2x monthly',
  );
  assert.equal(sumCents([...perMonth.values()].map((n) => n * 100)) / 100, dates.length);
});

test('biweekly over five years never approximates to 26 a year', () => {
  const dates = expandSchedule({ start: '2026-01-02', frequency: 'biweekly', ...FIVE_YEARS });
  assert.equal(dates.length, 131, 'five years of biweekly is 131 paychecks here, not 26 * 5 = 130');
  assert.notEqual(dates.length, NOMINAL_PER_YEAR.biweekly * 5,
    'the nominal figure is for display only — never multiply by it to get money');

  // The extra paycheck has to land in some specific year, and that year's cash is higher.
  const perYear = new Map();
  for (const d of dates) {
    const y = d.slice(0, 4);
    perYear.set(y, (perYear.get(y) ?? 0) + 1);
  }
  const twentySeven = [...perYear].filter(([, n]) => n === 27).map(([y]) => y);
  assert.deepEqual(twentySeven, ['2027'], 'exactly one year in this window has 27 paychecks');
  assert.equal(perYear.get('2026'), 26);
});

test('semimonthly defaults to the 15th and the last day', () => {
  const dates = expandSchedule({ start: '2026-01-01', frequency: 'semimonthly', ...YEAR });
  assert.equal(dates.length, 24);
  assert.deepEqual(dates.slice(0, 4), ['2026-01-15', '2026-01-31', '2026-02-15', '2026-02-28']);
  assert.equal(dates[dates.length - 1], '2026-12-31');

  const custom = expandSchedule({ start: '2026-01-01', frequency: 'semimonthly', anchorDay: 5, anchorDay2: 20, ...YEAR });
  assert.deepEqual(custom.slice(0, 3), ['2026-01-05', '2026-01-20', '2026-02-05']);
});

/* ---- the month-end trap ---- */

test('a schedule anchored on the 31st stays on month-ends and never walks off', () => {
  const dates = expandSchedule({ start: '2026-01-31', frequency: 'monthly', ...FIVE_YEARS });

  assert.equal(dates.length, 60, 'five years of monthly is exactly 60 payments');
  assert.equal(new Set(dates.map(toPeriod)).size, 60, 'one payment per month, no month skipped or doubled');
  assert.equal(dates[1], '2026-02-28', 'February clamps');
  assert.equal(dates[2], '2026-03-31', 'March returns to the 31st — the anchor is re-derived');
  assert.equal(dates[25], '2028-02-29', 'a leap February gets the 29th');
  assert.equal(dates[26], '2028-03-31');
});

test("dayRule 'last' pins to the end of every month regardless of the anchor", () => {
  const dates = expandSchedule({ start: '2026-01-15', frequency: 'monthly', dayRule: 'last', ...YEAR });
  assert.deepEqual(dates.slice(0, 3), ['2026-01-31', '2026-02-28', '2026-03-31']);
  throwsCode(
    () => expandSchedule({ start: '2026-01-15', frequency: 'monthly', dayRule: 'rollover', ...YEAR }),
    'recurrence.bad_day_rule',
  );
});

test('an anchor day earlier than the start date does not emit a payment before the source began', () => {
  const dates = expandSchedule({ start: '2026-01-20', frequency: 'monthly', anchorDay: 15, ...YEAR });
  assert.equal(dates[0], '2026-02-15', 'the 15 Jan payment is skipped — the job started on the 20th');
  assert.equal(dates.length, 11);
});

test('leap day is handled in every direction', () => {
  const annual = expandSchedule({
    start: '2028-02-29', frequency: 'annual',
    windowStart: '2028-01-01', windowEnd: '2032-12-31',
  });
  assert.deepEqual(annual, ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
});

/* ---- windows and bounds ---- */

test('occurrences are clipped to the window and to the source end date', () => {
  const ended = expandSchedule({
    start: '2026-01-15', end: '2026-06-30', frequency: 'monthly', ...YEAR,
  });
  assert.equal(ended.length, 6);
  assert.equal(ended[ended.length - 1], '2026-06-15');

  const clipped = expandSchedule({
    start: '2026-01-15', frequency: 'monthly',
    windowStart: '2026-04-01', windowEnd: '2026-06-30',
  });
  assert.deepEqual(clipped, ['2026-04-15', '2026-05-15', '2026-06-15'],
    'earlier occurrences are dropped, not shifted');

  assert.deepEqual(
    expandSchedule({ start: '2027-01-01', frequency: 'monthly', ...YEAR }), [],
    'a source starting after the window emits nothing',
  );
  throwsCode(
    () => expandSchedule({ start: '2026-01-01', frequency: 'monthly', windowStart: '2026-12-31', windowEnd: '2026-01-01' }),
    'recurrence.reversed_window',
  );
});

test('business-day rules move payments off weekends', () => {
  // 2026-08-15 and 2026-08-16 are a Saturday and Sunday.
  const next = expandSchedule({
    start: '2026-08-15', frequency: 'monthly', businessDayRule: 'next-business',
    windowStart: '2026-08-01', windowEnd: '2026-10-31',
  });
  assert.equal(next[0], '2026-08-17', 'Saturday shifts to Monday');

  const prev = expandSchedule({
    start: '2026-08-15', frequency: 'monthly', businessDayRule: 'prev-business',
    windowStart: '2026-08-01', windowEnd: '2026-10-31',
  });
  assert.equal(prev[0], '2026-08-14', 'Saturday shifts back to Friday');
});

test('dates come back ascending and deduplicated', () => {
  const dates = expandSchedule({
    start: '2026-01-30', frequency: 'monthly', businessDayRule: 'prev-business', ...YEAR,
  });
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i] > dates[i - 1], `not ascending at ${dates[i - 1]} -> ${dates[i]}`);
  }
  assert.equal(new Set(dates).size, dates.length);
});

/* ---- proration ---- */

test('prorate covers whole, partial and empty overlaps', () => {
  assert.equal(prorate(310_00, '2026-01-01', '2026-01-31', '2026-01-01', '2026-01-31'), 310_00);
  assert.equal(prorate(310_00, '2026-01-01', '2026-01-31', '2026-01-20', '2026-01-31'), 120_00,
    '12 of 31 days');
  assert.equal(prorate(310_00, '2026-01-01', '2026-01-31', '2026-02-01', '2026-02-28'), 0,
    'no overlap is zero, not a negative');
  assert.equal(prorate(310_00, '2026-01-01', '2026-01-31', '2026-01-31', '2026-01-31'), 1000,
    'a single day is 1/31, inclusive on both ends');
  assert.equal(prorate(310_00, '2026-01-01', '2026-01-31', '2025-01-01', '2027-01-01'), 310_00,
    'over-wide cover is capped at the full amount');
});

test('prorateMonth works from a period string', () => {
  assert.equal(prorateMonth(280_00, '2026-02', '2026-02-15', '2026-12-31'), 140_00,
    '14 of 28 days in February 2026');
  assert.equal(daysInMonthOf('2028-02-01'), 29);
});

/* ---- growth ---- */

test('annual-step growth raises on the anniversary, not continuously', () => {
  const salary = 100_000_00;
  assert.equal(applyGrowth(salary, 0.03, 0), salary);
  assert.equal(applyGrowth(salary, 0.03, 11), salary, 'no raise before the anniversary');
  assert.equal(applyGrowth(salary, 0.03, 12), 103_000_00, 'the raise lands all at once');
  assert.equal(applyGrowth(salary, 0.03, 23), 103_000_00);
  assert.equal(applyGrowth(salary, 0.03, 24), 106_090_00, 'and compounds year on year');
});

test('monthly-compound growth is smooth, and the two modes genuinely differ', () => {
  const base = 100_000_00;
  assert.equal(applyGrowth(base, 0.03, 6, 'monthly-compound'), 101_488_92);
  assert.ok(
    applyGrowth(base, 0.03, 6, 'monthly-compound') > applyGrowth(base, 0.03, 6, 'annual-step'),
    'mid-year, smooth compounding is ahead of a step raise',
  );
  assert.equal(applyGrowth(base, 0.03, 12, 'monthly-compound'), applyGrowth(base, 0.03, 12, 'annual-step'),
    'they agree exactly on the anniversary');
});

test('growth edge cases', () => {
  assert.equal(applyGrowth(100_00, 0, 60), 100_00);
  assert.equal(applyGrowth(100_00, 0.05, 12, 'none'), 100_00);
  assert.equal(applyGrowth(100_00, -0.1, 12), 90_00, 'a decline is allowed — royalties decay');
  throwsCode(() => applyGrowth(100_00, -1, 12), 'recurrence.rate_wipes_out');
  throwsCode(() => applyGrowth(100_00, 0.03, 1.5), 'recurrence.bad_elapsed');
  throwsCode(() => applyGrowth(100_00, NaN, 12), 'recurrence.bad_rate');
  throwsCode(() => applyGrowth(100_00, 0.03, 12, 'exponential'), 'recurrence.bad_growth_mode');
});

test('elapsedMonths floors to whole months', () => {
  assert.equal(elapsedMonths('2026-01-15', '2026-01-15'), 0);
  assert.equal(elapsedMonths('2026-01-15', '2026-02-14'), 0, 'a day short is not a month');
  assert.equal(elapsedMonths('2026-01-15', '2026-02-15'), 1);
  assert.equal(elapsedMonths('2026-01-15', '2027-01-15'), 12);
  assert.equal(elapsedMonths('2026-01-15', '2026-12-31'), 11);
});

/* ---- payment lag ---- */

test('shiftForLag moves cash to when it actually arrives', () => {
  assert.equal(shiftForLag('2026-03-31', 45), '2026-05-15', 'net-45 work in March is May cash');
  assert.equal(shiftForLag('2026-03-31', 0), '2026-03-31');
  assert.equal(shiftForLag('2026-08-14', 1, 'next-business'), '2026-08-17', 'lands on a Saturday, pays Monday');
  throwsCode(() => shiftForLag('2026-03-31', -5), 'recurrence.negative_lag');
  throwsCode(() => shiftForLag('2026-03-31', 1.5), 'recurrence.bad_lag');
});

/* ---- splitting ---- */

test('splitting an annual amount always sums back exactly', () => {
  const annual = 140_000_00;
  for (const count of [12, 24, 26, 27, 52, 53]) {
    const parts = splitEvenly(annual, count);
    assert.equal(parts.length, count);
    assert.equal(sumCents(parts), annual, `${count} payments did not sum back to the annual figure`);
  }
  throwsCode(() => splitEvenly(100, 0), 'recurrence.bad_count');
});

test('splitAcross supports a seasonal profile and still sums exactly', () => {
  const dates = ['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31'];
  const even = splitAcross(100_000_00, dates);
  assert.equal(sumCents(even), 100_000_00);

  const seasonal = splitAcross(100_000_00, dates, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(sumCents(seasonal), 100_000_00, 'a weighted split still reconciles');
  assert.deepEqual(seasonal, [10_000_00, 20_000_00, 30_000_00, 40_000_00]);

  assert.deepEqual(splitAcross(100, []), []);
  throwsCode(() => splitAcross(100, dates, [1, 1]), 'recurrence.weight_mismatch');
});

test('perOccurrenceFromAnnual reconciles against the real dates, not the nominal count', () => {
  // 2027 is the 27-paycheck year for this anchor. Dividing the annual salary by the
  // nominal 26 would overpay by a full extra cheque.
  const dates = expandSchedule({
    start: '2026-01-02', frequency: 'biweekly',
    windowStart: '2027-01-01', windowEnd: '2027-12-31',
  });
  const parts = perOccurrenceFromAnnual(140_000_00, dates);
  assert.equal(parts.length, 27, 'this year has 27 paychecks');
  assert.equal(sumCents(parts), 140_000_00, 'and they still total the annual salary exactly');
  assert.notEqual(parts[0], Math.round(140_000_00 / 26), 'dividing by the nominal count would be wrong');
});
