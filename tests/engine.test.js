import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runComparison, runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules, TAX_RESERVE_ACCOUNT } from '../model/close-rules.js';
import { COMPARISON_MODES } from '../model/realize.js';
import { sumCents } from '../model/money.js';
import { sumCash } from '../model/events.js';
import { sliceModel, simpleModel, aSource } from './helpers/models.js';
import { shuffle, seededRandom } from './helpers/build.js';

before(() => registerBuiltInCloseRules());

/* ---- the pipeline runs end to end ---- */

test('a simple model produces a month per horizon month and a closing balance', () => {
  const run = runProjection(simpleModel());

  assert.equal(run.months.length, 12);
  assert.equal(run.months[0].period, '2026-01');
  assert.equal(run.months[11].period, '2026-12');
  assert.equal(run.months[0].opening.cash, 10_000_00);
  assert.ok(run.runKey.length === 16, 'every run carries a key');
});

test('the balance identity holds for every account in every month', () => {
  // ledger.js asserts this internally too; this test proves the assertion is reachable
  // and that a real model satisfies it.
  const run = runProjection(sliceModel());

  for (const month of run.months) {
    for (const account of Object.keys(month.closing)) {
      const moved = sumCents(
        run.events
          .filter((e) => e.period === month.period && e.account === account)
          .map((e) => e.cashAmount),
      );
      assert.equal(
        month.closing[account],
        (month.opening[account] ?? 0) + moved,
        `${month.period} / ${account} does not reconcile`,
      );
    }
  }
});

test('closing balances chain: this month opens where last month closed', () => {
  const run = runProjection(sliceModel());
  for (let i = 1; i < run.months.length; i++) {
    assert.deepEqual(
      run.months[i].opening,
      run.months[i - 1].closing,
      `${run.months[i].period} does not open where ${run.months[i - 1].period} closed`,
    );
  }
});

/* ---- the slice behaves as the plan describes ---- */

test('the vertical slice: two jobs with a gap, and cash dips during it', () => {
  const run = runProjection(sliceModel(), { mode: 'lost' });

  const salaryIn = (period) =>
    sumCash(run.events, (e) => e.period === period && e.kind === 'income' && e.category === 'salary');

  assert.ok(salaryIn('2026-06') > 0, 'the first job is still paying in June');
  assert.equal(salaryIn('2026-08'), 0, 'nothing is earned during the gap');
  assert.equal(salaryIn('2026-09'), 0);
  assert.ok(salaryIn('2026-10') > 0, 'the second job starts in October');

  const cashAt = (period) => run.months.find((m) => m.period === period).closing.cash;
  assert.ok(cashAt('2026-09') < cashAt('2026-06'), 'the unemployment gap draws cash down');
});

test('the first date cash drops below the emergency target is identifiable', () => {
  const run = runProjection(sliceModel(), { mode: 'lost' });

  // Three months of essential spending.
  const target = 6_500_00 * 3;
  const firstBelow = run.months.find((m) => m.liquid < target);

  assert.ok(firstBelow, 'this slice is meant to dip below a three-month reserve');
  assert.equal(firstBelow.period, '2026-07', 'the first month of the gap eats into the reserve');
  assert.ok(run.minLiquid.amount < target);
});

test('the minimum is the true intra-month low, which a month-end figure would hide', () => {
  const run = runProjection(sliceModel(), { mode: 'lost' });

  // Rent is due on 1 October, before the new job's first paycheck on the 15th.
  assert.equal(run.minLiquid.period, '2026-10');
  assert.equal(run.minLiquid.date, '2026-10-01');
  assert.equal(run.minLiquid.amount, -390_00);
  assert.equal(run.minLiquid.label, 'Living costs', 'and it names what caused it');

  const october = run.months.find((m) => m.period === '2026-10');
  assert.ok(october.liquid > 0, 'the month CLOSES positive — only the running balance shows the overdraft');
});

test('a contract paid net-45 arrives as cash in the month it is paid, not invoiced', () => {
  const run = runProjection(sliceModel(), { mode: 'won' });
  const contract = run.events.filter((e) => e.sourceId === 'contract_acme');

  assert.equal(contract.length, 1);
  assert.equal(contract[0].meta.invoiceDate, '2026-08-31', 'invoiced at the end of August');
  assert.equal(contract[0].date, '2026-10-15', 'net-45 makes it October cash');
  assert.equal(contract[0].period, '2026-10');
  assert.equal(contract[0].taxCategory, 'se_net_profit');
});

/* ---- uncertainty ---- */

test('won, expected and lost are three different futures, and lost is the useful one', () => {
  const runs = runComparison(sliceModel(), COMPARISON_MODES);
  const endCash = (mode) => runs.get(mode).balances.cash;

  assert.ok(endCash('lost') < endCash('expected'), 'expected sits above lost');
  assert.ok(endCash('expected') < endCash('won'), 'and below won');

  // The 60%-likely $40,000 contract is the whole difference.
  assert.equal(endCash('won') - endCash('lost'), 40_000_00 - 0 - taxReserveOn(runs, 'won'),
    'the gap between won and lost is the contract, less what its tax reserve holds back');

  assert.deepEqual(runs.get('lost').omittedSourceIds, ['contract_acme'],
    'a lost contract is omitted, not zeroed, so it does not clutter tables');
  assert.deepEqual(runs.get('won').omittedSourceIds, []);
});

function taxReserveOn(runs, mode) {
  return runs.get(mode).balances[TAX_RESERVE_ACCOUNT] ?? 0;
}

test('the expected run scales the amount but keeps the event', () => {
  const run = runProjection(sliceModel(), { mode: 'expected' });
  const contract = run.events.find((e) => e.sourceId === 'contract_acme');

  assert.equal(contract.cashAmount, 24_000_00, '60% of $40,000');
  assert.equal(contract.taxableAmount, 24_000_00);
  assert.equal(contract.realization, 'expected');
  assert.equal(contract.probability, 0.6, 'the original odds are still legible on the event');
});

test('a model with no uncertainty gives the same run under every mode', () => {
  const keys = new Set();
  for (const mode of ['won', 'expected', 'lost']) {
    keys.add(runProjection(simpleModel(), { mode }).runKey);
  }
  assert.equal(keys.size, 1, 'with nothing uncertain, every mode must agree exactly');
});

/* ---- the tax reserve (degenerate version) ---- */

test('untaxed contract income is earmarked, so spendable cash is not overstated', () => {
  const run = runProjection(sliceModel(), { mode: 'won' });

  const reserve = run.balances[TAX_RESERVE_ACCOUNT];
  assert.equal(reserve, 12_000_00, '30% of the $40,000 contract');

  // The reserve is a transfer, so it must not change net worth.
  const netWorth = Object.values(run.balances).reduce((a, b) => a + b, 0);
  const noReserve = runProjection(sliceModel({ taxReserveRate: 0 }), { mode: 'won' });
  const netWorthNoReserve = Object.values(noReserve.balances).reduce((a, b) => a + b, 0);
  assert.equal(netWorth, netWorthNoReserve, 'earmarking money does not create or destroy any');
  assert.ok(run.balances.cash < noReserve.balances.cash, 'but it does reduce spendable cash');
});

test('salary is not reserved against, because it was already withheld', () => {
  const salaryOnly = sliceModel({
    sources: sliceModel().sources.filter((s) => s.type !== 'contract'),
    taxReserveRate: 0.3,
  });
  const run = runProjection(salaryOnly);
  assert.equal(run.balances[TAX_RESERVE_ACCOUNT] ?? 0, 0,
    'withheld income must not be reserved against a second time');
});

/* ---- determinism and order independence ---- */

test('two runs of the same model are byte-identical', () => {
  const model = sliceModel();
  const a = runProjection(model);
  const b = runProjection(model);
  assert.equal(a.runKey, b.runKey);
  assert.deepEqual(a.months, b.months);
});

test('shuffling the source list changes nothing', () => {
  // Compilers are pure functions of one source, so order must not matter. If this fails,
  // something is reading state across sources.
  const model = sliceModel();
  const reference = runProjection(model);
  const random = seededRandom(31);

  for (let i = 0; i < 10; i++) {
    const shuffled = runProjection({ ...model, sources: shuffle(model.sources, random) });
    assert.equal(shuffled.runKey, reference.runKey, `source order changed the result on trial ${i}`);
    assert.deepEqual(shuffled.balances, reference.balances);
  }
});

test('a disabled source emits nothing, and re-enabling it restores the exact run', () => {
  const model = sliceModel();
  const reference = runProjection(model);

  const disabled = {
    ...model,
    sources: model.sources.map((s) => (s.id === 'job_second' ? { ...s, enabled: false } : s)),
  };
  const withoutJob = runProjection(disabled);

  assert.equal(withoutJob.events.filter((e) => e.sourceId === 'job_second').length, 0);
  assert.notEqual(withoutJob.runKey, reference.runKey);

  const reEnabled = runProjection({
    ...disabled,
    sources: disabled.sources.map((s) => (s.id === 'job_second' ? { ...s, enabled: true } : s)),
  });
  assert.equal(reEnabled.runKey, reference.runKey, 'toggling off and on must return to exactly where we were');
});

/* ---- guard rails ---- */

test('the engine refuses a scenario it has no resolver for', () => {
  assert.throws(
    () => runProjection(simpleModel(), { scenarioId: 'job-change' }),
    (err) => err.code === 'engine.no_scenario_resolver',
  );
});

test('a model with nothing feeding back settles in a single pass', () => {
  const run = runProjection(simpleModel());
  assert.equal(run.iterations, 1, 'no feedback means no second pass is needed');
});

test('taxable savings interest makes the engine iterate to a fixed point', async () => {
  // Interest is taxable AND depends on a running balance, so pass A has to be redone once
  // pass B has produced it. This is the case the maxIterations hatch was built for.
  const { PACKS } = await import('./helpers/packs.js');
  const model = {
    ...simpleModel(),
    taxPacks: PACKS,
    accounts: [
      { id: 'cash', name: 'Checking', kind: 'checking', openingBalance: 10_000_00, expectedReturn: 0 },
      { id: 'savings', name: 'Savings', kind: 'savings', openingBalance: 200_000_00, expectedReturn: 0.04, personId: 'p1' },
    ],
  };

  const run = runProjection(model);

  assert.ok(run.iterations > 1, 'taxable growth should force a second pass');
  assert.ok(run.balances.savings > 200_000_00, 'the balance compounded');

  const interest = run.events.filter((e) => e.kind === 'growth' && e.taxableAmount !== 0);
  assert.ok(interest.length > 0, 'interest should be taxable');
  assert.equal(interest[0].taxCategory, 'interest');

  // And that interest actually reached the tax result.
  assert.ok(run.book[2026].p1.interest > 0, 'interest must appear in the taxable book');
});

test('unrealised growth is not taxed until it is sold', () => {
  const model = {
    ...simpleModel(),
    accounts: [
      { id: 'cash', name: 'Checking', kind: 'checking', openingBalance: 10_000_00 },
      { id: 'brokerage', name: 'Investments', kind: 'brokerage', openingBalance: 100_000_00, expectedReturn: 0.07 },
    ],
  };
  const run = runProjection(model);

  const growth = run.events.filter((e) => e.kind === 'growth' && e.account === 'brokerage');
  assert.ok(growth.length > 0, 'the brokerage should grow');
  assert.ok(growth.every((e) => e.taxableAmount === 0), 'a paper gain is not income');
  assert.equal(run.iterations, 1, 'and nothing feeds back, so one pass is enough');
});

test('maxIterations must be a positive integer', () => {
  assert.throws(
    () => runProjection(simpleModel(), { maxIterations: 0 }),
    (err) => err.code === 'engine.bad_iterations',
  );
});

test('an unknown source type warns instead of throwing', () => {
  const model = simpleModel();
  model.sources.push({ ...aSource('expense', { id: 'weird', startDate: '2026-01-01' }), type: 'crypto_mining' });

  const run = runProjection(model);
  const warning = run.warnings.find((w) => w.code === 'source.unknown_type');
  assert.ok(warning, 'expected an unknown-type warning');
  assert.equal(warning.severity, 'error');
  assert.ok(run.months.length === 12, 'the rest of the model still runs');
});

test('a payment landing past the horizon is dropped with a warning, not silently', () => {
  const model = simpleModel({
    sources: [
      aSource('contract', {
        id: 'late_invoice', name: 'December work', personId: 'p1',
        startDate: '2026-12-15', endDate: '2026-12-15',
        details: { amount: 10_000_00, frequency: 'once', paymentLagDays: 60 },
      }),
    ],
  });
  const run = runProjection(model);

  const warning = run.warnings.find((w) => w.code === 'horizon.event_dropped');
  assert.ok(warning, 'net-60 December work is paid in February, past a horizon ending in December');
  assert.match(warning.message, /2027-02-13/);
  assert.equal(run.events.filter((e) => e.sourceId === 'late_invoice').length, 0);
});
