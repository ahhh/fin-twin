import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, addMonths, addPeriods, addYears, applyBusinessDayRule, civilFromDays, clampISO,
  compareISO, dateInMonth, daysBetween, daysFromCivil, daysInMonth, endOfMonth, fromEpochDay,
  isLeapYear, isValidISO, isWeekend, isWithin, monthsInRange, nextBusinessDay, parseISO,
  parsePeriod, periodToISO, periodsBetween, prevBusinessDay, startOfMonth, toEpochDay,
  toPeriod, todayISO, weekday, yearOf,
} from '../model/dates.js';

function code(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

test('parseISO accepts real dates and rejects impostors', () => {
  assert.deepEqual(parseISO('2026-08-11'), { y: 2026, m: 8, d: 11 });
  assert.equal(code(() => parseISO('2026-02-30')), 'date.bad_day');
  assert.equal(code(() => parseISO('2026-13-01')), 'date.bad_month');
  assert.equal(code(() => parseISO('2026-8-1')), 'date.bad_format', 'must be zero-padded');
  assert.equal(code(() => parseISO('11/08/2026')), 'date.bad_format');
  assert.equal(code(() => parseISO(20260811)), 'date.not_string');

  assert.ok(isValidISO('2028-02-29'), '2028 is a leap year');
  assert.ok(!isValidISO('2027-02-29'));
});

test('leap years and month lengths', () => {
  assert.ok(isLeapYear(2028) && isLeapYear(2000));
  assert.ok(!isLeapYear(2027) && !isLeapYear(1900) && !isLeapYear(2100));
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2027, 2), 28);
  assert.equal(daysInMonth(2026, 4), 30);
});

test('civil/epoch conversion round-trips across a wide range', () => {
  assert.equal(daysFromCivil(1970, 1, 1), 0);
  assert.equal(toEpochDay('2026-08-11'), 20676);
  assert.equal(fromEpochDay(0), '1970-01-01');

  // Every day across a leap year and a century boundary.
  for (let day = toEpochDay('2027-11-01'); day <= toEpochDay('2029-03-01'); day++) {
    const iso = fromEpochDay(day);
    assert.equal(toEpochDay(iso), day, `round-trip failed at ${iso}`);
    const { y, m, d } = civilFromDays(day);
    assert.equal(daysFromCivil(y, m, d), day);
  }
  assert.equal(fromEpochDay(toEpochDay('2028-02-28') + 1), '2028-02-29');
  assert.equal(fromEpochDay(toEpochDay('2027-02-28') + 1), '2027-03-01');
});

test('addMonths clamps rather than rolling over — the bug this module exists to prevent', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29', 'leap year gets the 29th');
  assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(addMonths('2026-08-11', 1), '2026-09-11');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15', 'crosses the year');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-01-31', 13), '2027-02-28');

  assert.equal(addMonths('2026-08-11', 1, 'last'), '2026-09-30');
  assert.equal(code(() => addMonths('2026-08-11', 1, 'rollover')), 'date.bad_day_rule');
  assert.equal(code(() => addMonths('2026-08-11', 1.5)), 'date.bad_offset');
});

test('a monthly schedule anchored on the 31st stays in its month for five years', () => {
  // The failure mode: 60 monthly paychecks becoming 59 or 61 because Feb rolled into March.
  let iso = '2026-01-31';
  const seen = [];
  for (let i = 0; i < 60; i++) {
    seen.push(addMonths(iso, i));
  }
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen.map(toPeriod)).size, 60, 'every payment lands in a distinct month');
  assert.equal(seen[1], '2026-02-28');
  assert.equal(seen[13], '2027-02-28');
  assert.equal(seen[25], '2028-02-29');
});

test('addYears and addDays', () => {
  assert.equal(addYears('2028-02-29', 1), '2029-02-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.equal(daysBetween('2026-08-11', '2026-08-11'), 0);
});

test('comparison and range helpers', () => {
  assert.equal(compareISO('2026-01-01', '2026-01-02'), -1);
  assert.equal(compareISO('2026-01-02', '2026-01-01'), 1);
  assert.equal(compareISO('2026-01-01', '2026-01-01'), 0);
  assert.ok(isWithin('2026-06-01', '2026-01-01', '2026-12-31'));
  assert.ok(isWithin('2026-01-01', '2026-01-01', '2026-12-31'), 'inclusive at the start');
  assert.ok(isWithin('2026-12-31', '2026-01-01', '2026-12-31'), 'inclusive at the end');
  assert.ok(!isWithin('2027-01-01', '2026-01-01', '2026-12-31'));
  assert.equal(clampISO('2025-01-01', '2026-01-01', '2026-12-31'), '2026-01-01');
  assert.equal(clampISO('2027-01-01', '2026-01-01', '2026-12-31'), '2026-12-31');
  assert.equal(clampISO('2026-06-01', '2026-01-01', '2026-12-31'), '2026-06-01');
});

test('month boundaries and anchor days', () => {
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfMonth('2028-02-10'), '2028-02-29');
  assert.equal(startOfMonth('2026-02-10'), '2026-02-01');
  assert.equal(dateInMonth(2026, 2, 31), '2026-02-28', 'anchor beyond month end clamps');
  assert.equal(dateInMonth(2026, 2, 'last'), '2026-02-28');
  assert.equal(dateInMonth(2026, 8, 15), '2026-08-15');
  assert.equal(code(() => dateInMonth(2026, 8, 0)), 'date.bad_anchor');
  assert.equal(code(() => dateInMonth(2026, 8, 32)), 'date.bad_anchor');
});

test('periods', () => {
  assert.equal(toPeriod('2026-08-11'), '2026-08');
  assert.deepEqual(parsePeriod('2026-08'), { y: 2026, m: 8 });
  assert.equal(code(() => parsePeriod('2026-13')), 'date.bad_month');
  assert.equal(code(() => parsePeriod('2026-08-11')), 'date.bad_period');
  assert.equal(addPeriods('2026-12', 1), '2027-01');
  assert.equal(addPeriods('2026-01', -1), '2025-12');
  assert.equal(addPeriods('2026-08', 30), '2029-02');
  assert.equal(periodsBetween('2026-08', '2027-08'), 12);
  assert.equal(periodsBetween('2027-08', '2026-08'), -12);
  assert.equal(periodToISO('2026-02', 'last'), '2026-02-28');
  assert.equal(yearOf('2026-08-11'), 2026);
});

test('monthsInRange is inclusive on both ends', () => {
  assert.deepEqual(monthsInRange('2026-08-11', '2026-11-02'), ['2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepEqual(monthsInRange('2026-08-01', '2026-08-31'), ['2026-08']);
  assert.equal(monthsInRange('2026-01-01', '2030-12-31').length, 60, 'a five-year horizon is 60 months');
  assert.equal(code(() => monthsInRange('2026-12-01', '2026-01-01')), 'date.reversed_range');
});

test('weekday is correct against known dates', () => {
  assert.equal(weekday('1970-01-01'), 4, '1970-01-01 was a Thursday');
  assert.equal(weekday('2026-08-11'), 2, '2026-08-11 is a Tuesday');
  assert.equal(weekday('2000-01-01'), 6, '2000-01-01 was a Saturday');
  assert.equal(weekday('2026-04-15'), 3, 'tax day 2026 is a Wednesday');
  assert.equal(weekday('1969-12-31'), 3, 'weekday works before the epoch');

  // Weekdays must advance by exactly one per day with no gaps.
  let prev = weekday('2027-11-01');
  for (let i = 1; i <= 400; i++) {
    const w = weekday(addDays('2027-11-01', i));
    assert.equal(w, (prev + 1) % 7);
    prev = w;
  }
});

test('business-day rules move off weekends', () => {
  assert.ok(isWeekend('2026-08-15') && isWeekend('2026-08-16'), '15-16 Aug 2026 is a weekend');
  assert.equal(nextBusinessDay('2026-08-15'), '2026-08-17');
  assert.equal(prevBusinessDay('2026-08-16'), '2026-08-14');
  assert.equal(nextBusinessDay('2026-08-11'), '2026-08-11', 'a weekday is left alone');
  assert.equal(applyBusinessDayRule('2026-08-15', 'none'), '2026-08-15');
  assert.equal(applyBusinessDayRule('2026-08-15', 'next-business'), '2026-08-17');
  assert.equal(applyBusinessDayRule('2026-08-15', 'prev-business'), '2026-08-14');
  assert.equal(code(() => applyBusinessDayRule('2026-08-15', 'nearest')), 'date.bad_business_rule');
});

test('todayISO returns a valid date in the local timezone', () => {
  const today = todayISO();
  assert.ok(isValidISO(today), `todayISO returned "${today}"`);
  // Whatever TZ the suite runs under, today must agree with the local clock.
  const now = new Date();
  assert.equal(today, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`);
});
