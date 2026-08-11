import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CENTS, MoneyError, allocate, assertCents, atLeastZero, dollarsToCents, isCents,
  parseMoney, roundHalfAwayFromZero, scaleCents, share, sumCents,
} from '../model/money.js';

function code(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

test('assertCents rejects anything that is not an integer count of cents', () => {
  assert.equal(code(() => assertCents(12.5)), 'money.not_integer');
  assert.equal(code(() => assertCents('100')), 'money.not_integer');
  assert.equal(code(() => assertCents(NaN)), 'money.not_integer');
  assert.equal(code(() => assertCents(MAX_CENTS + 1)), 'money.out_of_range');
  assert.equal(assertCents(-4200), -4200);
  assert.ok(isCents(0) && !isCents(0.5));
});

test('rounding is half away from zero, symmetrically', () => {
  assert.equal(roundHalfAwayFromZero(0.5), 1);
  assert.equal(roundHalfAwayFromZero(-0.5), -1, 'Math.round would give -0 here, breaking symmetry');
  assert.equal(roundHalfAwayFromZero(1.5), 2);
  assert.equal(roundHalfAwayFromZero(-1.5), -2);
  assert.equal(roundHalfAwayFromZero(2.4), 2);
  assert.equal(roundHalfAwayFromZero(-2.4), -2);

  // An amount and its exact mirror must round to mirrored results, or a refund and its
  // original charge disagree by a cent.
  for (const n of [0.5, 1.5, 2.5, 12.5, 1234.5]) {
    assert.equal(roundHalfAwayFromZero(-n), -roundHalfAwayFromZero(n), `asymmetric at ${n}`);
  }
});

test('scaleCents multiplies by a rate and stays in cents', () => {
  assert.equal(scaleCents(10_000, 0.5), 5_000);
  assert.equal(scaleCents(10_001, 0.5), 5_001, 'half away from zero rounds .5 up');
  assert.equal(scaleCents(-10_001, 0.5), -5_001);
  assert.equal(scaleCents(1_234_56, 0.062), 7_654);
  assert.equal(code(() => scaleCents(100, Infinity)), 'money.bad_factor');
});

test('allocate splits a total so the parts sum back to it exactly', () => {
  // The canonical failure: $100.00 three ways is 33.33 + 33.33 + 33.33 = 99.99.
  const thirds = allocate(10_000, [1, 1, 1]);
  assert.equal(sumCents(thirds), 10_000);
  assert.deepEqual(thirds, [3334, 3333, 3333]);

  for (const [total, weights] of [
    [10_000, [1, 1, 1]],
    [100_00, [1, 2, 3, 4]],
    [1, [1, 1, 1, 1, 1]],
    [7, [3, 3, 3]],
    [999_99, [0.1, 0.2, 0.7]],
    [-10_000, [1, 1, 1]],
    [0, [5, 5]],
  ]) {
    const parts = allocate(total, weights);
    assert.equal(parts.length, weights.length);
    assert.equal(sumCents(parts), total, `parts of ${total} split ${weights} do not sum back`);
  }
});

test('allocate is deterministic and gives the remainder to the biggest loser first', () => {
  assert.deepEqual(allocate(10_000, [1, 1, 1]), allocate(10_000, [1, 1, 1]));
  // 1 cent over 4 equal weights: all tie, so the earliest index wins.
  assert.deepEqual(allocate(1, [1, 1, 1, 1]), [1, 0, 0, 0]);
  // 5 cents over 2 weights: 2.5 each; both tie, earliest gets the odd cent.
  assert.deepEqual(allocate(5, [1, 1]), [3, 2]);
});

test('allocate handles degenerate weights instead of dividing by zero', () => {
  assert.deepEqual(allocate(300, [0, 0, 0]), [100, 100, 100], 'all-zero weights split evenly');
  assert.equal(code(() => allocate(100, [])), 'money.no_weights');
  assert.equal(code(() => allocate(100, [1, -1])), 'money.bad_weight');
});

test('quarterly instalments always sum to the requirement', () => {
  // The property invariant #10 depends on: four instalments reconcile exactly.
  for (let required = 0; required < 4000; required += 7) {
    const instalments = allocate(required, [0.25, 0.25, 0.25, 0.25]);
    assert.equal(sumCents(instalments), required);
  }
});

test('sumCents validates every element rather than coercing', () => {
  assert.equal(sumCents([100, -50, 25]), 75);
  assert.equal(sumCents([]), 0);
  assert.equal(code(() => sumCents([100, 1.5])), 'money.not_integer');
});

test('share and atLeastZero', () => {
  assert.equal(share(10_000, 1, 3), 3_333);
  assert.equal(code(() => share(100, 1, 0)), 'money.divide_by_zero');
  assert.equal(atLeastZero(-500), 0);
  assert.equal(atLeastZero(500), 500);
});

test('dollarsToCents and parseMoney read human input', () => {
  assert.equal(dollarsToCents(1234.56), 123_456);
  assert.equal(dollarsToCents(0.1 + 0.2), 30, 'float noise must not leak into cents');

  assert.equal(parseMoney('$1,234.56'), 123_456);
  assert.equal(parseMoney('  2600 '), 260_000);
  assert.equal(parseMoney('-45.10'), -4_510);
  assert.equal(parseMoney('(45.10)'), -4_510, 'accounting-style negatives');
  assert.equal(parseMoney(''), null, 'blank is distinguishable from zero');
  assert.equal(parseMoney(null), null);
  assert.equal(code(() => parseMoney('abc')), 'money.unparseable');
  assert.equal(code(() => parseMoney('1.2.3')), 'money.unparseable');
});

test('MoneyError carries a machine-readable code', () => {
  const err = new MoneyError('money.test', 'x');
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'money.test');
});
