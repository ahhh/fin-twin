/**
 * Turning "every other Friday" into a list of dates, and amounts into per-date amounts.
 *
 * Shared by every source compiler, so a salary, a rent bill and a royalty statement all
 * agree on what "monthly" means and none of them re-implements month-end clamping.
 */

import {
  addDays, addMonths, applyBusinessDayRule, compareISO, dateInMonth, daysBetween,
  daysInMonth, isAfter, isBefore, isOnOrAfter, isOnOrBefore, parseISO, toISO,
} from './dates.js';
import { allocate, assertCents, scaleCents } from './money.js';

export class RecurrenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecurrenceError';
    this.code = code;
  }
}

export const FREQUENCIES = Object.freeze([
  'once', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'semiannual', 'annual',
]);

/**
 * How many times a frequency occurs in a nominal year.
 *
 * FOR DISPLAY AND ANNUALISATION ONLY. Biweekly is listed as 26, but a real biweekly
 * schedule produces 27 paychecks in roughly one year out of every eleven, and the
 * three-paycheck month is a genuine cash-flow event people plan around. Anything that
 * affects money must count actual dates from `expandSchedule`, never multiply by these.
 */
export const NOMINAL_PER_YEAR = Object.freeze({
  once: 1, weekly: 52, biweekly: 26, semimonthly: 24,
  monthly: 12, quarterly: 4, semiannual: 2, annual: 1,
});

const MONTH_STEP = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 };

/** Guard against a bad frequency turning into an unbounded loop. */
const MAX_OCCURRENCES = 10_000;

/**
 * Expand a schedule into the list of dates it lands on, clipped to a window.
 *
 * @param {Object} spec
 * @param {string} spec.start          First possible occurrence, 'YYYY-MM-DD'.
 * @param {string|null} [spec.end]     Last possible occurrence; null means open-ended.
 * @param {string} spec.frequency
 * @param {number|'last'|null} [spec.anchorDay]  Day of month for the monthly family.
 *                                     Defaults to the start date's own day.
 * @param {number|'last'|null} [spec.anchorDay2] Second day, semimonthly only. Default 'last'.
 * @param {'clamp'|'last'} [spec.dayRule]        What to do when the anchor day does not
 *                                     exist in a month. 'clamp' -> 31 Jan becomes 28 Feb.
 * @param {'none'|'next-business'|'prev-business'} [spec.businessDayRule]
 * @param {string} spec.windowStart    Clip: drop occurrences before this.
 * @param {string} spec.windowEnd      Clip: stop at this.
 * @returns {string[]} ascending, deduped dates
 */
export function expandSchedule(spec) {
  const {
    start, end = null, frequency,
    anchorDay = null, anchorDay2 = null,
    dayRule = 'clamp', businessDayRule = 'none',
    windowStart, windowEnd,
  } = spec;

  if (!FREQUENCIES.includes(frequency)) {
    throw new RecurrenceError('recurrence.bad_frequency',
      `unknown frequency "${frequency}" (expected one of ${FREQUENCIES.join(', ')})`);
  }
  parseISO(start);
  parseISO(windowStart);
  parseISO(windowEnd);
  if (end !== null) parseISO(end);

  if (isAfter(windowStart, windowEnd)) {
    throw new RecurrenceError('recurrence.reversed_window',
      `window starts after it ends: ${windowStart} .. ${windowEnd}`);
  }

  // Nothing can occur after the source ends or after the window closes.
  const hardStop = end === null ? windowEnd : (isBefore(end, windowEnd) ? end : windowEnd);
  if (isAfter(start, hardStop)) return [];

  const raw = generateRaw({ start, hardStop, frequency, anchorDay, anchorDay2, dayRule });

  // The business-day rule can move a date across the window edge, so clip AFTER shifting.
  const shifted = businessDayRule === 'none'
    ? raw
    : raw.map((iso) => applyBusinessDayRule(iso, businessDayRule));

  const out = [];
  for (const iso of shifted) {
    if (isBefore(iso, windowStart) || isAfter(iso, windowEnd)) continue;
    if (out.length === 0 || out[out.length - 1] !== iso) out.push(iso);
  }
  return out.sort(compareISO);
}

function generateRaw({ start, hardStop, frequency, anchorDay, anchorDay2, dayRule }) {
  const dates = [];
  const push = (iso) => {
    if (dates.length >= MAX_OCCURRENCES) {
      throw new RecurrenceError('recurrence.runaway',
        `schedule produced more than ${MAX_OCCURRENCES} occurrences — check the frequency and window`);
    }
    dates.push(iso);
  };

  if (frequency === 'once') {
    push(start);
    return dates;
  }

  // Day-stepped frequencies anchor on the start date itself. This is what makes a
  // biweekly schedule produce 26 or 27 paychecks a year naturally, and puts the third
  // paycheck in whichever month it actually falls.
  if (frequency === 'weekly' || frequency === 'biweekly') {
    const step = frequency === 'weekly' ? 7 : 14;
    for (let iso = start; isOnOrBefore(iso, hardStop); iso = addDays(iso, step)) push(iso);
    return dates;
  }

  if (frequency === 'semimonthly') {
    const first = anchorDay ?? 15;
    const second = anchorDay2 ?? 'last';
    let cursor = toISO({ ...parseISO(start), d: 1 });
    while (isOnOrBefore(cursor, hardStop)) {
      const { y, m } = parseISO(cursor);
      for (const anchor of [first, second]) {
        const iso = dateInMonth(y, m, anchor);
        if (isOnOrAfter(iso, start) && isOnOrBefore(iso, hardStop)) push(iso);
      }
      cursor = addMonths(cursor, 1);
    }
    return dates.sort(compareISO);
  }

  const step = MONTH_STEP[frequency];
  const startParts = parseISO(start);
  const anchor = anchorDay ?? startParts.d;

  // The first occurrence is the anchored date in the start month, if it has not already
  // passed; otherwise the next period. Without this, a source starting on the 20th with a
  // 15th anchor would emit a payment on the 15th, five days before it began.
  // The dayRule applies here too, not only when stepping.
  let cursor = anchoredDate(startParts.y, startParts.m, anchor, dayRule);
  if (isBefore(cursor, start)) cursor = stepAnchored(cursor, step, anchor, dayRule);

  while (isOnOrBefore(cursor, hardStop)) {
    push(cursor);
    cursor = stepAnchored(cursor, step, anchor, dayRule);
  }
  return dates;
}

/**
 * Step forward by whole months, re-deriving the day from the ANCHOR rather than from the
 * previous occurrence.
 *
 * That distinction matters: stepping 31 Jan -> 28 Feb -> 31 Mar re-derives correctly,
 * whereas carrying the clamped day forward would give 28 Feb -> 28 Mar -> 28 Apr and
 * silently walk a month-end schedule off the end of the month for good.
 */
function stepAnchored(iso, monthStep, anchor, dayRule) {
  const { y, m } = parseISO(addMonths(iso, monthStep, 'clamp'));
  return anchoredDate(y, m, anchor, dayRule);
}

/** The date within (y, m) that the anchor and the day-rule select. */
function anchoredDate(y, m, anchor, dayRule) {
  if (dayRule === 'last') return dateInMonth(y, m, 'last');
  if (dayRule !== 'clamp') {
    throw new RecurrenceError('recurrence.bad_day_rule', `unknown dayRule "${dayRule}"`);
  }
  return dateInMonth(y, m, anchor);
}

/* -------------------------------------------------------------------------- */
/* Amounts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Scale an amount to the fraction of a period actually covered.
 *
 * Used when a source starts or ends mid-period: someone who starts on the 20th of a
 * 31-day month earns 12/31 of that month's pay, not all of it and not none of it.
 * Both ends are inclusive, so a single-day overlap is 1 day, not 0.
 */
export function prorate(amountCents, periodStart, periodEnd, coverStart, coverEnd) {
  assertCents(amountCents);
  const periodDays = daysBetween(periodStart, periodEnd) + 1;
  if (periodDays <= 0) {
    throw new RecurrenceError('recurrence.empty_period',
      `period ${periodStart}..${periodEnd} covers no days`);
  }

  const from = isAfter(coverStart, periodStart) ? coverStart : periodStart;
  const to = isBefore(coverEnd, periodEnd) ? coverEnd : periodEnd;
  if (isAfter(from, to)) return 0;

  const coveredDays = daysBetween(from, to) + 1;
  if (coveredDays >= periodDays) return amountCents;
  return scaleCents(amountCents, coveredDays / periodDays);
}

/** Convenience: prorate a calendar month by the days a source was active within it. */
export function prorateMonth(amountCents, period, coverStart, coverEnd) {
  const [y, m] = period.split('-').map(Number);
  const first = dateInMonth(y, m, 1);
  const last = dateInMonth(y, m, 'last');
  return prorate(amountCents, first, last, coverStart, coverEnd);
}

/**
 * Grow an amount over time.
 *
 *   'annual-step'      a raise on each anniversary — how salaries actually behave.
 *   'monthly-compound' smooth compounding — how an inflation-indexed cost behaves.
 *   'none'             no growth.
 *
 * The two modes differ by up to a full year of growth, so the choice is exposed in the
 * form rather than buried here: a salary that quietly compounded monthly would drift
 * noticeably above reality across a five-year projection.
 */
export function applyGrowth(baseCents, annualRate, elapsedMonths, mode = 'annual-step') {
  assertCents(baseCents);
  if (typeof annualRate !== 'number' || !Number.isFinite(annualRate)) {
    throw new RecurrenceError('recurrence.bad_rate', `growth rate must be finite, got ${annualRate}`);
  }
  if (!Number.isInteger(elapsedMonths)) {
    throw new RecurrenceError('recurrence.bad_elapsed',
      `elapsedMonths must be an integer, got ${elapsedMonths}`);
  }
  if (annualRate === 0 || mode === 'none' || elapsedMonths === 0) return baseCents;
  if (annualRate <= -1) {
    throw new RecurrenceError('recurrence.rate_wipes_out',
      `a growth rate of ${annualRate} would drive the amount to zero or negative`);
  }

  const months = Math.max(0, elapsedMonths);
  if (mode === 'annual-step') {
    return scaleCents(baseCents, (1 + annualRate) ** Math.floor(months / 12));
  }
  if (mode === 'monthly-compound') {
    return scaleCents(baseCents, (1 + annualRate) ** (months / 12));
  }
  throw new RecurrenceError('recurrence.bad_growth_mode', `unknown growth mode "${mode}"`);
}

/** Whole months from `fromISO` to `toISO`, floored — the input to applyGrowth. */
export function elapsedMonths(fromISO, toISO_) {
  const a = parseISO(fromISO);
  const b = parseISO(toISO_);
  let months = (b.y - a.y) * 12 + (b.m - a.m);
  if (b.d < a.d) months -= 1;
  return months;
}

/**
 * Move a date later by a payment lag, then apply a business-day rule.
 *
 * Work performed in March and paid on net-45 terms is cash in May. Modelling that as
 * March cash is the single most common way a freelance cash-flow projection looks
 * comfortable while the real bank balance does not.
 */
export function shiftForLag(iso, lagDays = 0, businessDayRule = 'none') {
  if (!Number.isInteger(lagDays)) {
    throw new RecurrenceError('recurrence.bad_lag', `lagDays must be an integer, got ${lagDays}`);
  }
  if (lagDays < 0) {
    throw new RecurrenceError('recurrence.negative_lag',
      `lagDays cannot be negative (got ${lagDays}) — payment cannot precede the work`);
  }
  return applyBusinessDayRule(addDays(iso, lagDays), businessDayRule);
}

/**
 * Split a total evenly across n payments so the parts sum back exactly.
 *
 * An annual salary divided by 26 paychecks leaves a remainder; dropping it loses money
 * from the projection, and re-rounding each payment loses a different amount each year.
 */
export function splitEvenly(totalCents, count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new RecurrenceError('recurrence.bad_count', `count must be a positive integer, got ${count}`);
  }
  return allocate(totalCents, new Array(count).fill(1));
}

/** Split a total across specific dates, weighted by an optional seasonal profile. */
export function splitAcross(totalCents, dates, weights = null) {
  if (dates.length === 0) return [];
  if (weights === null) return splitEvenly(totalCents, dates.length);
  if (weights.length !== dates.length) {
    throw new RecurrenceError('recurrence.weight_mismatch',
      `got ${weights.length} weights for ${dates.length} dates`);
  }
  return allocate(totalCents, weights);
}

/** Per-occurrence amount for an annualised figure, given the dates it actually lands on. */
export function perOccurrenceFromAnnual(annualCents, dates) {
  return splitEvenly(annualCents, Math.max(1, dates.length));
}

/** Days in the calendar month containing `iso`. */
export function daysInMonthOf(iso) {
  const { y, m } = parseISO(iso);
  return daysInMonth(y, m);
}
