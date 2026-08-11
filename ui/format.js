/**
 * Formatting, at the very edge of the app.
 *
 * Nothing else formats. The model deals in integer cents and ISO date strings; this is
 * where they become text a person reads. Keeping that boundary sharp is what stops a
 * formatted string leaking back into arithmetic.
 */

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
/**
 * Month names as a lookup rather than via Intl.DateTimeFormat.
 *
 * Formatting a date through Intl means constructing a Date, and a Date built from a
 * 'YYYY-MM-DD' string is parsed as UTC but read back in local time — which is exactly the
 * off-by-one-month bug `model/dates.js` exists to prevent. A label is not worth
 * reintroducing it for, so the whole of this module stays Date-free.
 */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Cents to "$1,234.56". */
export function money(cents, { whole = false } = {}) {
  if (cents === null || cents === undefined) return '—';
  return (whole ? USD_WHOLE : USD).format(cents / 100);
}

/** Cents to "$1,235" — for axes and KPI tiles, where cents are noise. */
export const moneyShort = (cents) => money(cents, { whole: true });

/**
 * Compact money for chart axes: "$1.2M", "$45k".
 * Never used for a figure the user might act on — only for tick labels.
 */
export function moneyAxis(cents) {
  if (cents === null || cents === undefined) return '';
  const dollars = cents / 100;
  const sign = dollars < 0 ? '−' : '';
  const size = Math.abs(dollars);
  if (size >= 1_000_000) return `${sign}$${(size / 1_000_000).toFixed(size >= 10_000_000 ? 0 : 1)}M`;
  if (size >= 1_000) return `${sign}$${(size / 1_000).toFixed(size >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${size.toFixed(0)}`;
}

export function percent(ratio, { places = 1 } = {}) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'percent', maximumFractionDigits: places, minimumFractionDigits: 0,
  }).format(ratio);
}

export function months(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)} months`;
}

/** 'YYYY-MM' to "Mar 2027". */
export function periodLabel(period) {
  if (!period) return '—';
  const [year, month] = period.split('-').map(Number);
  return `${MONTH_SHORT[month - 1]} ${year}`;
}

/** 'YYYY-MM-DD' to "15 March 2027". */
export function dateLabel(iso) {
  if (!iso) return '—';
  const [year, month, day] = iso.split('-').map(Number);
  return `${day} ${MONTH_LONG[month - 1]} ${year}`;
}

/** Format by the unit a metric declares. */
export function byUnit(value, unit) {
  switch (unit) {
    case 'cents': return money(value);
    case 'ratio': return percent(value);
    case 'months': return months(value);
    case 'period': return periodLabel(value);
    default: return value === null || value === undefined ? '—' : String(value);
  }
}

/**
 * A signed amount with its direction stated in words as well as by sign.
 *
 * Colour alone must never carry the meaning: a screen reader and a monochrome printout
 * both need the word.
 */
export function signedMoney(cents) {
  if (cents === null || cents === undefined) return { text: '—', direction: 'none', className: '' };
  if (cents === 0) return { text: money(0), direction: 'no change', className: '' };
  return {
    text: `${cents < 0 ? '−' : '+'}${money(Math.abs(cents))}`,
    direction: cents < 0 ? 'down' : 'up',
    className: cents < 0 ? 'amount-negative' : 'amount-positive',
  };
}

/** Title-case a machine key for display: 'tax_reserve' -> 'Tax reserve'. */
export function humanise(key) {
  if (!key) return '';
  const spaced = key.replace(/^system:/, '').replace(/[_:-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Pluralise without a library. */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
