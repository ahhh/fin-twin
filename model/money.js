/**
 * Integer-cent arithmetic.
 *
 * Every monetary value in the model is a signed integer number of cents. Floats are
 * allowed only as *rates* (0.062, 0.9235) and only as an input to the rounding functions
 * here — never as an accumulator. `$0.10 + $0.20 !== $0.30` in binary floating point, and
 * a five-year projection accumulates that error across thousands of additions.
 *
 * The two functions that matter are `scaleCents` (one rounding rule, everywhere) and
 * `allocate` (splitting a total so the parts sum back to it exactly).
 */

/** Largest magnitude we allow, leaving headroom below Number.MAX_SAFE_INTEGER for sums. */
export const MAX_CENTS = 2 ** 48; // ~$2.8 trillion — far beyond any household, far below 2^53

export class MoneyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MoneyError';
    this.code = code;
  }
}

/** Throw unless `value` is a safe integer count of cents within range. */
export function assertCents(value, what = 'amount') {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MoneyError(
      'money.not_integer',
      `${what} must be an integer number of cents, got ${typeof value} ${String(value)}. ` +
        'Dollars are a formatting concern; the model stores cents.',
    );
  }
  if (!Number.isFinite(value) || Math.abs(value) > MAX_CENTS) {
    throw new MoneyError('money.out_of_range', `${what} is out of range: ${value} cents`);
  }
  return value;
}

export function isCents(value) {
  return Number.isInteger(value) && Math.abs(value) <= MAX_CENTS;
}

/**
 * Round a real number to an integer, half away from zero.
 *
 * This is the *only* rounding rule in the model. Math.round is biased (it rounds -0.5 to 0
 * but 0.5 to 1), which makes an expense and its mirror-image refund disagree by a cent.
 */
export function roundHalfAwayFromZero(n) {
  if (!Number.isFinite(n)) {
    throw new MoneyError('money.not_finite', `cannot round ${n}`);
  }
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** Multiply cents by a rate, returning cents. */
export function scaleCents(cents, factor) {
  assertCents(cents);
  if (typeof factor !== 'number' || !Number.isFinite(factor)) {
    throw new MoneyError('money.bad_factor', `factor must be a finite number, got ${factor}`);
  }
  return assertCents(roundHalfAwayFromZero(cents * factor), 'scaled amount');
}

/** Sum a list of cent amounts, validating each. */
export function sumCents(list) {
  let total = 0;
  for (const value of list) {
    assertCents(value);
    total += value;
  }
  return assertCents(total, 'sum');
}

/**
 * Split `total` into parts proportional to `weights`, such that the parts sum to `total`
 * **exactly**.
 *
 * Rounding each part independently loses or gains cents: $100.00 split three ways gives
 * three $33.33 parts that sum to $99.99. Here the remainder is distributed one cent at a
 * time to the parts with the largest fractional loss (ties break toward the earlier index),
 * so the split is exact and deterministic.
 *
 * Used for: quarterly estimated tax instalments, splitting an annual amount across pay
 * periods, and sinking-fund reserve legs — anywhere a drifting cent would break an
 * invariant.
 */
export function allocate(total, weights) {
  assertCents(total, 'total');
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new MoneyError('money.no_weights', 'allocate needs at least one weight');
  }
  for (const w of weights) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      throw new MoneyError('money.bad_weight', `weights must be finite and >= 0, got ${w}`);
    }
  }

  const weightTotal = weights.reduce((a, b) => a + b, 0);

  // All-zero weights: fall back to an even split so callers do not have to special-case it.
  if (weightTotal === 0) return allocate(total, weights.map(() => 1));

  const exact = weights.map((w) => (total * w) / weightTotal);
  const floored = exact.map((x) => (x < 0 ? Math.ceil(x) : Math.floor(x)));
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  // Hand out the remaining cents to whoever lost the most in the truncation.
  const order = exact
    .map((x, i) => ({ i, frac: Math.abs(x - floored[i]) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const step = remainder < 0 ? -1 : 1;
  for (let k = 0; remainder !== 0; k++) {
    floored[order[k % order.length].i] += step;
    remainder -= step;
  }

  return floored;
}

/** Proportional split by an integer numerator/denominator, exact by construction. */
export function share(total, numerator, denominator) {
  if (denominator === 0) throw new MoneyError('money.divide_by_zero', 'denominator is zero');
  return scaleCents(total, numerator / denominator);
}

/** Clamp to a floor of zero — for amounts that cannot meaningfully go negative. */
export function atLeastZero(cents) {
  assertCents(cents);
  return cents < 0 ? 0 : cents;
}

/** Convert a dollar figure to cents. Only for parsing input and writing fixtures. */
export function dollarsToCents(dollars) {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars)) {
    throw new MoneyError('money.bad_dollars', `expected a finite number, got ${dollars}`);
  }
  return assertCents(roundHalfAwayFromZero(dollars * 100), 'dollar amount');
}

/**
 * Parse user input ("$1,234.56", "-1234.56", "1234") to cents.
 * Returns null for empty input so a form can distinguish "blank" from "zero".
 */
export function parseMoney(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim();
  if (text === '') return null;

  const cleaned = text.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d*(\.\d*)?$/.test(cleaned) || cleaned === '' || cleaned === '-') {
    throw new MoneyError('money.unparseable', `could not read "${input}" as an amount`);
  }
  return dollarsToCents(Number(cleaned));
}
