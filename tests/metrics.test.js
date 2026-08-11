import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules, SINKING_PREFIX } from '../model/close-rules.js';
import { computeMetrics } from '../model/metrics.js';
import { sumCash } from '../model/events.js';
import { sliceModel, simpleModel, aSource } from './helpers/models.js';
import { PACKS } from './helpers/packs.js';

before(() => registerBuiltInCloseRules());

/* ---- metric contract ---- */

test('every metric carries its definition, not just a number', () => {
  // A savings rate without a stated definition is a number people misread.
  const run = runProjection(sliceModel());

  for (const [name, value] of Object.entries(run.metrics)) {
    assert.equal(typeof value, 'object', `${name} is a bare value`);
    assert.ok('value' in value, `${name} has no value`);
    assert.ok('unit' in value, `${name} has no unit`);
    assert.ok(typeof value.definition === 'string' && value.definition.length > 20,
      `${name} has no usable definition`);
  }
});

test('both savings rates are reported, each labelled, and neither is called "the" rate', () => {
  const run = runProjection(sliceModel());
  assert.ok(run.metrics.cashSavingsRate);
  assert.ok(run.metrics.longTermSavingsRate);
  assert.equal(run.metrics.savingsRate, undefined, 'no unqualified savings rate may exist');
  assert.match(run.metrics.cashSavingsRate.definition, /after-tax/i);
  assert.match(run.metrics.longTermSavingsRate.definition, /gross earned/i);
});

/* ---- emergency fund ---- */

test('the emergency fund is measured against essential spending, not all spending', () => {
  const model = simpleModel({
    sources: [
      aSource('expense', {
        id: 'rent', name: 'Rent', startDate: '2026-01-01',
        details: { amount: 2_000_00, frequency: 'monthly', essential: true, inflationRate: 0 },
      }),
      aSource('expense', {
        id: 'fun', name: 'Going out', startDate: '2026-01-01',
        details: { amount: 1_000_00, frequency: 'monthly', essential: false, inflationRate: 0 },
      }),
    ],
    openingBalances: { cash: 12_000_00 },
  });
  const run = runProjection(model);

  assert.equal(run.metrics.monthlyEssentialSpend.value, 2_000_00);
  assert.equal(run.metrics.monthlySpend.value, 3_000_00, 'total spending is higher');

  // A three-month target is $6,000 against essentials but would be $9,000 against total
  // spending — enough to make a perfectly sound reserve look inadequate.
  assert.equal(run.metrics.emergencyTarget.value, 6_000_00, 'three months of essentials');
  assert.notEqual(run.metrics.emergencyTarget.value, run.metrics.monthlySpend.value * 3);
  assert.match(run.metrics.emergencyMonths.definition, /essential/i);
});

test('income concentration names the source it is concentrated in', () => {
  const run = runProjection(sliceModel(), { mode: 'won' });
  const largest = run.metrics.incomeConcentration;

  assert.ok(largest.value > 0 && largest.value <= 1);
  assert.ok(largest.inputs.sourceName, 'the KPI must name the source, not just a share');
  assert.ok(run.metrics.topThreeConcentration.value >= largest.value);
});

test('variable income share counts uncertain and lumpy sources', () => {
  const run = runProjection(sliceModel(), { mode: 'won' });
  assert.ok(run.metrics.variableIncomeShare.value > 0,
    'the slice contains an uncertain contract');
  assert.ok(run.metrics.variableIncomeShare.value < 1, 'but salary is dependable');
});

test('the minimum cash metric reports when and why, not just how much', () => {
  const run = runProjection(sliceModel(), { mode: 'lost' });
  const min = run.metrics.minimumCash;

  assert.equal(min.value, -390_00);
  assert.equal(min.inputs.period, '2026-10');
  assert.equal(min.inputs.cause, 'Living costs');
  assert.match(min.definition, /part-way through a month/);
});

/* ---- spendable cash and the reserve gap ---- */

test('spendable cash is lower than the bank balance when tax is owed', () => {
  const model = sliceModel({ taxPacks: PACKS, taxReserveRate: 0 });
  const run = runProjection(model, { mode: 'won' });

  assert.ok(run.metrics.taxReserveGap.value > 0, 'a contract with no withholding leaves tax owed');
  assert.ok(
    run.metrics.spendableCash.value < run.metrics.liquidCash.value,
    'the bank balance overstates what is free to spend',
  );
  assert.equal(
    run.metrics.spendableCash.value,
    run.metrics.liquidCash.value - run.metrics.taxReserveGap.value,
  );
});

test('setting money aside closes the reserve gap without changing net worth', () => {
  const withReserve = runProjection(sliceModel({ taxPacks: PACKS, taxReserveRate: 0.3 }), { mode: 'won' });
  const without = runProjection(sliceModel({ taxPacks: PACKS, taxReserveRate: 0 }), { mode: 'won' });

  assert.ok(withReserve.metrics.taxReserveGap.value < without.metrics.taxReserveGap.value,
    'earmarking reduces the unfunded gap');
  assert.equal(withReserve.metrics.netWorth.value, without.metrics.netWorth.value,
    'but moving money between your own accounts changes no net worth');
});

/* ---- sinking funds ---- */

function sinkingModel(enabled) {
  return simpleModel({
    horizon: { startDate: '2026-01-01', endDate: '2026-12-31' },
    openingBalances: { cash: 10_000_00 },
    sources: [
      aSource('expense', {
        id: 'insurance', name: 'Car insurance', startDate: '2026-06-30',
        details: {
          amount: 2_400_00, frequency: 'annual', essential: true, inflationRate: 0,
          category: 'insurance', sinkingFund: { enabled },
        },
      }),
    ],
  });
}

test('a sinking fund is net-worth neutral and does not double-count the bill', () => {
  const withFund = runProjection(sinkingModel(true));
  const without = runProjection(sinkingModel(false));

  const netWorth = (run) => Object.values(run.balances).reduce((a, b) => a + b, 0);
  assert.equal(netWorth(withFund), netWorth(without),
    'a transfer group sums to zero, so net worth must be identical');

  const expenses = (run) => sumCash(run.events, (e) => e.kind === 'expense');
  assert.equal(expenses(withFund), -2_400_00);
  assert.equal(expenses(withFund), expenses(without),
    'the bill is counted exactly once, on its real date, either way');
});

test('a sinking fund spreads the cash hit instead of one sudden drop', () => {
  const withFund = runProjection(sinkingModel(true));
  const without = runProjection(sinkingModel(false));

  const cashIn = (run, period) => run.months.find((m) => m.period === period).closing.cash;

  // Without the fund, June is a $2,400 cliff. With it, cash steps down each month.
  assert.equal(cashIn(without, '2026-05') - cashIn(without, '2026-06'), 2_400_00);
  assert.ok(cashIn(withFund, '2026-05') - cashIn(withFund, '2026-06') < 500_00,
    'the June drop is much smaller once the money has been set aside');
  assert.ok(cashIn(withFund, '2026-01') < cashIn(without, '2026-01'),
    'because saving started in January');
});

test('the reserve account holds the money until the bill lands', () => {
  const run = runProjection(sinkingModel(true));
  const account = `${SINKING_PREFIX}insurance`;

  const may = run.months.find((m) => m.period === '2026-05').closing[account];
  assert.equal(may, 2_400_00, 'fully funded by the end of May, before the bill lands in June');
  assert.equal(run.balances[account], 0, 'and spent exactly when the bill arrives');

  // No top-up was needed, because there was time to save.
  assert.equal(run.warnings.filter((w) => w.code === 'sinking.autocover').length, 0);
});

test('an underfunded sinking fund is topped up visibly, with a warning', () => {
  // The bill lands in the very first month, so there is no runway to save at all.
  const model = simpleModel({
    horizon: { startDate: '2026-01-01', endDate: '2026-06-30' },
    openingBalances: { cash: 10_000_00 },
    sources: [
      aSource('expense', {
        id: 'sudden', name: 'Sudden bill', startDate: '2026-01-15',
        details: {
          amount: 3_000_00, frequency: 'once', essential: true, inflationRate: 0,
          sinkingFund: { enabled: true },
        },
      }),
    ],
  });
  const run = runProjection(model);

  const warning = run.warnings.find((w) => w.code === 'sinking.autocover');
  assert.ok(warning, 'the top-up must be reported, not silently absorbed');
  assert.match(warning.message, /short by/);

  const adjustments = run.events.filter((e) => e.kind === 'adjustment');
  assert.ok(adjustments.length > 0, 'and it must be a visible row, not an invisible fix');
  assert.equal(sumCash(run.events, (e) => e.kind === 'adjustment'), 0,
    'the top-up is a transfer: it moves money, it does not create it');
});

/* ---- metrics are computable standalone ---- */

test('computeMetrics works on a run without a tax pass', () => {
  const run = runProjection(simpleModel());
  const metrics = computeMetrics(run);
  assert.equal(metrics.taxReserveGap.value, 0, 'no tax results means nothing unfunded to report');
  assert.ok(metrics.netWorth.value > 0);
});
