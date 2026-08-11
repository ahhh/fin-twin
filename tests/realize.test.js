import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAll, makeHorizon } from '../model/compile.js';
import { realize, hasUncertainty, isUncertain, rangeOf, MODES } from '../model/realize.js';
import { sumCash, sumTaxable, makeEvent } from '../model/events.js';
import { aSource } from './helpers/models.js';
import { throwsCode } from './helpers/build.js';

const YEAR_2026 = makeHorizon('2026-01-01', '2026-12-31');

/** Four quarterly royalty statements, paid the day they are issued to keep dates simple. */
function rangedRoyalty(overrides = {}) {
  const source = aSource('royalty', {
    id: 'book', personId: 'p1', name: 'Book',
    startDate: '2026-01-01', endDate: '2026-12-31',
    ...overrides,
    details: {
      amount: 4_500_00, lowAmount: 2_000_00, highAmount: 9_000_00,
      frequency: 'quarterly', statementLagDays: 0,
      ...(overrides.details ?? {}),
    },
  });
  return compileAll([source], { horizon: YEAR_2026 }).events;
}

/* ---- reading a range ---- */

test('a malformed range is treated as no range rather than throwing', () => {
  // `meta` is free-form, so a compiler could put anything under `range`. This is user data
  // arriving through a compiler: the engine reports, it does not repair, and it certainly
  // does not crash the projection.
  const base = {
    sourceId: 's1', date: '2026-01-01', kind: 'income', phase: 'INCOME_GROSS',
    account: 'cash', category: 'royalty', cashAmount: 100_00,
  };

  assert.equal(rangeOf(makeEvent(base)), null, 'no meta at all');
  assert.equal(rangeOf(makeEvent({ ...base, meta: { range: { low: 1, base: 2 } } })), null,
    'a missing end is not a range');
  assert.equal(rangeOf(makeEvent({ ...base, meta: { range: { low: 1.5, base: 2, high: 3 } } })), null,
    'money is integer cents or it is not money');
  assert.deepEqual(rangeOf(makeEvent({ ...base, meta: { range: { low: 1, base: 2, high: 3 } } })),
    { low: 1, base: 2, high: 3 });
});

test('a ranged event counts as uncertain even though it is certain to happen', () => {
  const events = rangedRoyalty();

  assert.ok(events.every((e) => e.probability === 1), 'these statements definitely arrive');
  assert.ok(events.every(isUncertain), 'but how much they pay is not known');
  assert.ok(hasUncertainty(events),
    'the UI decides whether to show three runs from this — a range has to count');
});

/* ---- realising a range ---- */

test('a range gives three genuinely different projections', () => {
  const events = rangedRoyalty();

  assert.equal(sumCash(realize(events, 'won').events), 36_000_00, 'four good statements');
  assert.equal(sumCash(realize(events, 'expected').events), 18_000_00, 'four ordinary ones');
  assert.equal(sumCash(realize(events, 'lost').events), 8_000_00, 'four bad ones');
});

test('a bad year is a smaller cheque, not an absent one', () => {
  // This is the difference between a range and a probability. Omitting a royalty in the
  // downside run would overstate the downside of the very thing the range describes.
  const { events, omittedSourceIds } = realize(rangedRoyalty(), 'lost');

  assert.equal(events.length, 4, 'still four statements');
  assert.deepEqual(omittedSourceIds, []);
  assert.ok(events.every((e) => e.cashAmount === 2_000_00));
});

test('taxable income follows the range down, so the tax bill moves with it', () => {
  const low = realize(rangedRoyalty(), 'lost').events;
  assert.equal(sumTaxable(low), 8_000_00);
  assert.ok(low.every((e) => e.taxCategory === 'se_net_profit'));
});

test('the low, base and high runs are labelled the way the modes are named', () => {
  assert.equal(realize(rangedRoyalty(), 'won').events[0].realization, 'won');
  assert.equal(realize(rangedRoyalty(), 'lost').events[0].realization, 'lost');
  // The base run changed nothing, so the event is passed through untouched rather than
  // relabelled — identity here is what keeps run hashes stable.
  assert.equal(realize(rangedRoyalty(), 'expected').events[0].realization, 'certain');
});

test('`certain` keeps the base amount, because it means ignore the uncertainty', () => {
  assert.equal(sumCash(realize(rangedRoyalty(), 'certain').events), 18_000_00);
});

/* ---- the two uncertainties compose ---- */

test('a range and a probability apply together, in that order', () => {
  // A book deal that might not be signed AND whose royalties are a guess: 60% likely to
  // pay somewhere between the low and high figure.
  const events = rangedRoyalty({
    endDate: '2026-03-31',
    certainty: { mode: 'probability', confidence: 0.6 },
  });
  assert.equal(events.length, 1);

  assert.equal(sumCash(realize(events, 'won').events), 9_000_00,
    'the good run is the high figure at full value, not 60% of it');
  assert.equal(sumCash(realize(events, 'expected').events), 2_700_00,
    'the middle run is the base figure scaled by the odds');

  const lost = realize(events, 'lost');
  assert.equal(lost.events.length, 0, 'it never happened, so there is no cheque of any size');
  assert.deepEqual(lost.omittedSourceIds, ['book']);
});

/* ---- everything else still holds ---- */

test('a stream with no uncertainty at all is returned untouched', () => {
  // Identity, not an equal copy: it keeps run keys identical across modes, which is what
  // makes "this model has no uncertainty" visible rather than implied.
  const events = compileAll([aSource('salary', {
    id: 'job', personId: 'p1', startDate: '2026-01-01',
    details: { annualAmount: 120_000_00, frequency: 'monthly' },
  })], { horizon: YEAR_2026 }).events;

  for (const mode of MODES) {
    assert.equal(realize(events, mode).events, events, `mode "${mode}" rebuilt the stream`);
  }
});

test('an unknown mode is refused rather than quietly treated as expected', () => {
  throwsCode(() => realize(rangedRoyalty(), 'optimistic'), 'realize.bad_mode');
});
