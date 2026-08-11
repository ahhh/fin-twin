/**
 * Date arithmetic on 'YYYY-MM-DD' strings, done with integers.
 *
 * This is the ONLY module allowed to construct a `Date`, and it does so in exactly one
 * function (`todayISO`). Everything else here is integer arithmetic on civil dates.
 *
 * Why the discipline: `new Date('2026-08-31')` parses as UTC midnight, but `.getMonth()`
 * reads local time. West of UTC that date *is* 30 August, so a monthly salary can silently
 * emit 59 or 61 paychecks across a five-year projection. Add `setMonth` overflow (31 Jan
 * plus one month lands on 3 March), DST, and leap days, and you get off-by-one-month totals
 * that nobody notices until a golden file shifts.
 *
 * The conversions below are Howard Hinnant's `days_from_civil` / `civil_from_days`, which
 * are exact for any proleptic Gregorian date and involve no floating point.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD_RE = /^(\d{4})-(\d{2})$/;

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export class DateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DateError';
    this.code = code;
  }
}

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  if (m < 1 || m > 12) throw new DateError('date.bad_month', `month out of range: ${m}`);
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Parse 'YYYY-MM-DD' into {y, m, d}. Throws on anything that is not a real calendar date. */
export function parseISO(iso) {
  if (typeof iso !== 'string') {
    throw new DateError('date.not_string', `expected a 'YYYY-MM-DD' string, got ${typeof iso}`);
  }
  const match = ISO_RE.exec(iso);
  if (!match) throw new DateError('date.bad_format', `expected 'YYYY-MM-DD', got "${iso}"`);

  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) throw new DateError('date.bad_month', `no month ${m} in "${iso}"`);
  if (d < 1 || d > daysInMonth(y, m)) {
    throw new DateError('date.bad_day', `"${iso}" is not a real date (${m}/${y} has ${daysInMonth(y, m)} days)`);
  }
  return { y, m, d };
}

export function isValidISO(iso) {
  try {
    parseISO(iso);
    return true;
  } catch {
    return false;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

export function toISO({ y, m, d }) {
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

/** Days since 1970-01-01, exact for any Gregorian date. */
export function daysFromCivil(y, m, d) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil. */
export function civilFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: y + (m <= 2 ? 1 : 0), m, d };
}

export function toEpochDay(iso) {
  const { y, m, d } = parseISO(iso);
  return daysFromCivil(y, m, d);
}

export function fromEpochDay(day) {
  return toISO(civilFromDays(day));
}

export function addDays(iso, n) {
  if (!Number.isInteger(n)) throw new DateError('date.bad_offset', `addDays needs an integer, got ${n}`);
  return fromEpochDay(toEpochDay(iso) + n);
}

export function daysBetween(fromISO, toISODate) {
  return toEpochDay(toISODate) - toEpochDay(fromISO);
}

/** -1, 0 or 1. Safe because ISO dates sort lexicographically. */
export function compareISO(a, b) {
  parseISO(a);
  parseISO(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export const isBefore = (a, b) => compareISO(a, b) < 0;
export const isAfter = (a, b) => compareISO(a, b) > 0;
export const isOnOrBefore = (a, b) => compareISO(a, b) <= 0;
export const isOnOrAfter = (a, b) => compareISO(a, b) >= 0;

/** Inclusive on both ends. */
export function isWithin(iso, startISO, endISO) {
  return isOnOrAfter(iso, startISO) && isOnOrBefore(iso, endISO);
}

export function clampISO(iso, startISO, endISO) {
  if (isBefore(iso, startISO)) return startISO;
  if (isAfter(iso, endISO)) return endISO;
  return iso;
}

/**
 * Add months, deciding what happens when the source day does not exist in the target month.
 *
 *   'clamp'  31 Jan + 1 month -> 28 Feb   (the sane default; never rolls into March)
 *   'last'   any date + n months -> the last day of the target month
 *
 * There is deliberately no "roll over" rule. Silently landing on 3 March is the bug this
 * module exists to prevent.
 */
export function addMonths(iso, n, dayRule = 'clamp') {
  if (!Number.isInteger(n)) throw new DateError('date.bad_offset', `addMonths needs an integer, got ${n}`);
  const { y, m, d } = parseISO(iso);

  const monthIndex = y * 12 + (m - 1) + n;
  const ty = Math.floor(monthIndex / 12);
  const tm = monthIndex - ty * 12 + 1;
  const last = daysInMonth(ty, tm);

  if (dayRule === 'last') return toISO({ y: ty, m: tm, d: last });
  if (dayRule !== 'clamp') throw new DateError('date.bad_day_rule', `unknown dayRule "${dayRule}"`);
  return toISO({ y: ty, m: tm, d: Math.min(d, last) });
}

export function addYears(iso, n, dayRule = 'clamp') {
  return addMonths(iso, n * 12, dayRule);
}

export function endOfMonth(iso) {
  const { y, m } = parseISO(iso);
  return toISO({ y, m, d: daysInMonth(y, m) });
}

export function startOfMonth(iso) {
  const { y, m } = parseISO(iso);
  return toISO({ y, m, d: 1 });
}

/**
 * Build a date from a year, month and an anchor day, where the anchor may be 'last' or a
 * day number beyond the end of the month (clamped).
 */
export function dateInMonth(y, m, anchorDay) {
  const last = daysInMonth(y, m);
  if (anchorDay === 'last') return toISO({ y, m, d: last });
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new DateError('date.bad_anchor', `anchorDay must be 1-31 or 'last', got ${anchorDay}`);
  }
  return toISO({ y, m, d: Math.min(anchorDay, last) });
}

/* ---- periods ('YYYY-MM') ---- */

export function toPeriod(iso) {
  parseISO(iso);
  return iso.slice(0, 7);
}

export function parsePeriod(period) {
  if (typeof period !== 'string') {
    throw new DateError('date.not_string', `expected a 'YYYY-MM' string, got ${typeof period}`);
  }
  const match = PERIOD_RE.exec(period);
  if (!match) throw new DateError('date.bad_period', `expected 'YYYY-MM', got "${period}"`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) throw new DateError('date.bad_month', `no month ${m} in "${period}"`);
  return { y, m };
}

export function periodToISO(period, anchorDay = 1) {
  const { y, m } = parsePeriod(period);
  return dateInMonth(y, m, anchorDay);
}

export function addPeriods(period, n) {
  const { y, m } = parsePeriod(period);
  const index = y * 12 + (m - 1) + n;
  const ty = Math.floor(index / 12);
  return `${String(ty).padStart(4, '0')}-${pad2(index - ty * 12 + 1)}`;
}

export function periodsBetween(fromPeriod, toPeriodStr) {
  const a = parsePeriod(fromPeriod);
  const b = parsePeriod(toPeriodStr);
  return (b.y * 12 + b.m) - (a.y * 12 + a.m);
}

/** Inclusive list of every month from `startISO` to `endISO`. */
export function monthsInRange(startISO, endISO) {
  if (isAfter(startISO, endISO)) {
    throw new DateError('date.reversed_range', `range starts after it ends: ${startISO} .. ${endISO}`);
  }
  const out = [];
  let period = toPeriod(startISO);
  const last = toPeriod(endISO);
  while (periodsBetween(period, last) >= 0) {
    out.push(period);
    period = addPeriods(period, 1);
  }
  return out;
}

export function yearOf(iso) {
  return parseISO(iso).y;
}

/* ---- weekdays ---- */

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday. */
export function weekday(iso) {
  const days = toEpochDay(iso);
  return ((days % 7) + 7 + 4) % 7;
}

export function isWeekend(iso) {
  const w = weekday(iso);
  return w === 0 || w === 6;
}

/**
 * Move off a weekend. Holidays are deliberately not modelled: they vary by jurisdiction and
 * would need their own dated rule pack. Where an exact statutory date matters — the
 * estimated-tax due dates — the date is stored in the tax rule pack, not derived here.
 */
export function nextBusinessDay(iso) {
  let out = iso;
  while (isWeekend(out)) out = addDays(out, 1);
  return out;
}

export function prevBusinessDay(iso) {
  let out = iso;
  while (isWeekend(out)) out = addDays(out, -1);
  return out;
}

/** Apply a business-day rule by name. 'none' leaves the date alone. */
export function applyBusinessDayRule(iso, rule = 'none') {
  switch (rule) {
    case 'none': return iso;
    case 'next-business': return nextBusinessDay(iso);
    case 'prev-business': return prevBusinessDay(iso);
    default: throw new DateError('date.bad_business_rule', `unknown business-day rule "${rule}"`);
  }
}

/* ---- the clock ---- */

/**
 * Today, in the viewer's local timezone, as 'YYYY-MM-DD'.
 *
 * The single place in the codebase that constructs a `Date`. Used for form defaults and
 * "months from now" displays. The engine never calls it: a projection is a pure function of
 * its model and horizon, which is what makes runs reproducible and golden files stable.
 */
export function todayISO() {
  const now = new Date();
  return toISO({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}
