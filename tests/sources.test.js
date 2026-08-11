import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAll, makeHorizon } from '../model/compile.js';
import { listSourceTypes, registerSourceType, setPath, getPath } from '../model/sources/index.js';
import { sumCash, sumTaxable, netPayFor } from '../model/events.js';
import { aSource } from './helpers/models.js';
import { throwsCode } from './helpers/build.js';

const YEAR_2026 = makeHorizon('2026-01-01', '2026-12-31');

function compileOne(source, horizon = YEAR_2026) {
  return compileAll([source], { horizon });
}

/* ---- registry contract ---- */

test('every registered source type honours the registry contract', () => {
  const types = listSourceTypes();
  assert.ok(types.length >= 4);

  for (const def of types) {
    const blank = def.defaults();
    assert.equal(blank.type, def.type, `${def.type} defaults() returns the wrong type`);
    assert.ok('details' in blank && 'certainty' in blank, `${def.type} defaults are incomplete`);
    assert.equal(typeof def.describe(blank), 'string');
    assert.ok(Array.isArray(def.check(blank)));

    // Every overridable path must actually resolve on a default instance, or a scenario
    // override would target something that does not exist.
    for (const path of def.overridablePaths) {
      assert.notEqual(getPath(blank, path), undefined,
        `${def.type}: overridable path "${path}" does not exist on a default source`);
    }
  }
});

test('setPath refuses to invent a field, so a typo cannot silently do nothing', () => {
  const source = aSource('salary', { id: 's', startDate: '2026-01-01' });
  setPath(source, 'details.growthRate', 0.05);
  assert.equal(source.details.growthRate, 0.05);

  throwsCode(() => setPath(source, 'details.growthRat', 0.05), 'registry.no_such_path');
  throwsCode(() => setPath(source, 'details.nested.deep', 1), 'registry.no_such_path');
  assert.equal(source.details.growthRat, undefined, 'nothing was created');
});

/* ---- salary ---- */

test('a six-month job pays six months of salary, not a full year', () => {
  // The bug this guards: dividing the annual amount by the paychecks that happen to fall
  // inside the window, rather than by the pay periods in a year.
  const half = aSource('salary', {
    id: 'half_year', personId: 'p1', startDate: '2026-01-01', endDate: '2026-06-30',
    details: { annualAmount: 120_000_00, frequency: 'semimonthly', growthRate: 0, federalWithholdingRate: 0, ficaRate: 0 },
  });
  const { events } = compileOne(half);

  assert.equal(events.filter((e) => e.kind === 'income').length, 12, 'twelve semimonthly cheques');
  assert.equal(sumCash(events, (e) => e.kind === 'income'), 60_000_00, 'exactly half the annual salary');
});

test('a full year of a month-based frequency pays exactly the annual salary', () => {
  // Monthly and semimonthly divide a year exactly (12 and 24). Weekly and biweekly do
  // not, and are covered by the extra-paycheck test below.
  for (const [frequency, expected] of [
    ['monthly', 120_000_00],
    ['semimonthly', 120_000_00],
  ]) {
    const source = aSource('salary', {
      id: `job_${frequency}`, personId: 'p1', startDate: '2026-01-01',
      details: { annualAmount: 120_000_00, frequency, growthRate: 0, federalWithholdingRate: 0, ficaRate: 0 },
    });
    const { events } = compileOne(source);
    const gross = sumCash(events, (e) => e.kind === 'income');
    assert.ok(Math.abs(gross - expected) <= 100,
      `${frequency}: expected about ${expected}, got ${gross} (rounding per cheque may leave a few cents)`);
  }
});

test('a 27-paycheck biweekly year genuinely pays more — that extra cheque is real', () => {
  const source = aSource('salary', {
    id: 'biweekly_job', personId: 'p1', startDate: '2026-01-02',
    details: { annualAmount: 130_000_00, frequency: 'biweekly', growthRate: 0, federalWithholdingRate: 0, ficaRate: 0 },
  });

  const in2026 = compileOne(source, makeHorizon('2026-01-01', '2026-12-31'));
  const in2027 = compileOne(source, makeHorizon('2027-01-01', '2027-12-31'));

  const gross = (r) => sumCash(r.events, (e) => e.kind === 'income');
  assert.equal(in2026.events.filter((e) => e.kind === 'income').length, 26);
  assert.equal(in2027.events.filter((e) => e.kind === 'income').length, 27);
  assert.equal(gross(in2026), 130_000_00);
  assert.equal(gross(in2027), 135_000_00, '27 cheques at annual/26 is one extra paycheck of income');

  // Weekly behaves the same way in a 53-week year.
  const weekly = aSource('salary', {
    id: 'weekly_job', personId: 'p1', startDate: '2026-01-01',
    details: { annualAmount: 104_000_00, frequency: 'weekly', growthRate: 0, federalWithholdingRate: 0, ficaRate: 0 },
  });
  const weeklyRun = compileOne(weekly);
  assert.equal(weeklyRun.events.filter((e) => e.kind === 'income').length, 53);
  assert.equal(gross(weeklyRun), 106_000_00, '53 weeks at annual/52');
});

test('a paycheck is several legs, and net pay is derived from them', () => {
  const source = aSource('salary', {
    id: 'job', personId: 'p1', startDate: '2026-01-01', endDate: '2026-01-31',
    details: {
      annualAmount: 120_000_00, frequency: 'monthly', growthRate: 0,
      preTaxRate: 0.1, federalWithholdingRate: 0.2, ficaRate: 0.0765,
    },
  });
  const { events } = compileOne(source);
  const groupId = events.find((e) => e.kind === 'income').groupId;

  const gross = 10_000_00;
  const preTax = 1_000_00;
  const federal = 1_800_00;      // 20% of gross less the pre-tax deferral
  const fica = 765_00;           // 7.65% of gross

  assert.equal(sumCash(events, (e) => e.kind === 'income'), gross);
  assert.equal(netPayFor(events, groupId), gross - preTax - federal - fica);

  // The deferral reduces taxable income; the withholding does not.
  assert.equal(sumTaxable(events), gross - preTax);
  assert.equal(events.filter((e) => e.kind === 'withholding').length, 2);

  // The retirement account received the deferral, so net worth is unchanged by it.
  assert.equal(sumCash(events, (e) => e.account === 'retirement'), preTax);
});

test('withholding larger than gross is reported, not quietly clamped', () => {
  const source = aSource('salary', {
    id: 'impossible', personId: 'p1', startDate: '2026-01-01',
    details: { annualAmount: 100_000_00, frequency: 'monthly', federalWithholdingRate: 0.8, ficaRate: 0.15, preTaxRate: 0.2 },
  });
  const { warnings } = compileOne(source);
  const warning = warnings.find((w) => w.code === 'source.withholding_exceeds_gross');
  assert.ok(warning);
  assert.equal(warning.severity, 'error');
});

/* ---- expense ---- */

test('an expense is negative cash, never taxable, and carries its essential flag', () => {
  const source = aSource('expense', {
    id: 'rent', startDate: '2026-01-01',
    details: { amount: 2_600_00, frequency: 'monthly', essential: true, cutPriority: 5, category: 'housing', inflationRate: 0 },
  });
  const { events } = compileOne(source);

  assert.equal(events.length, 12);
  assert.equal(sumCash(events), -31_200_00);
  assert.equal(sumTaxable(events), 0);
  assert.ok(events.every((e) => e.essential === true && e.cutPriority === 5));
  assert.ok(events.every((e) => e.tags.includes('essential')));
});

test('expense inflation compounds from the start date', () => {
  const source = aSource('expense', {
    id: 'groceries', startDate: '2026-01-01',
    details: { amount: 1_000_00, frequency: 'annual', inflationRate: 0.04, growthMode: 'annual-step' },
  });
  const { events } = compileOne(source, makeHorizon('2026-01-01', '2028-12-31'));

  assert.deepEqual(events.map((e) => -e.cashAmount), [1_000_00, 1_040_00, 1_081_60]);
});

/* ---- contract ---- */

test('a contract emits the full amount with its probability attached, never pre-multiplied', () => {
  // Scaling is a realisation concern. If the compiler pre-multiplied, one compiled stream
  // could not produce the won / expected / lost runs.
  const source = aSource('contract', {
    id: 'gig', personId: 'p1', startDate: '2026-03-01', endDate: '2026-03-01',
    certainty: { mode: 'probability', confidence: 0.4 },
    details: { amount: 25_000_00, frequency: 'once', paymentLagDays: 30 },
  });
  const { events } = compileOne(source);

  assert.equal(events.length, 1);
  assert.equal(events[0].cashAmount, 25_000_00, 'the full amount, not 40% of it');
  assert.equal(events[0].probability, 0.4);
  assert.equal(events[0].date, '2026-03-31', 'net-30 from a 1 March invoice');
  assert.equal(events[0].taxCategory, 'se_net_profit');
  assert.equal(events.filter((e) => e.kind === 'withholding').length, 0,
    '1099 income is not withheld at source — that is why the tax reserve exists');
});

/* ---- transfer ---- */

test('a transfer is two balanced legs and changes no net worth', () => {
  const source = aSource('transfer', {
    id: 'to_savings', startDate: '2026-01-01',
    details: { amount: 500_00, frequency: 'monthly', fromAccount: 'cash', toAccount: 'savings' },
  });
  const { events } = compileOne(source);

  assert.equal(events.length, 24, 'two legs a month');
  assert.equal(sumCash(events), 0, 'a transfer nets to zero — that is invariant #2');
  assert.equal(sumTaxable(events), 0);
  assert.equal(sumCash(events, (e) => e.account === 'cash'), -6_000_00);
  assert.equal(sumCash(events, (e) => e.account === 'savings'), 6_000_00);
});

/* ---- compile-level behaviour ---- */

test('two sources emitting on the same date and phase do not collide', () => {
  // The seq counter must be per source; sharing one across sources would make each id
  // depend on which source compiled first.
  const a = aSource('expense', { id: 'exp_a', name: 'A', startDate: '2026-01-01', details: { amount: 100_00, frequency: 'monthly', inflationRate: 0 } });
  const b = aSource('expense', { id: 'exp_b', name: 'B', startDate: '2026-01-01', details: { amount: 200_00, frequency: 'monthly', inflationRate: 0 } });

  const forward = compileAll([a, b], { horizon: YEAR_2026 });
  const reverse = compileAll([b, a], { horizon: YEAR_2026 });

  assert.deepEqual(
    forward.events.map((e) => e.id),
    reverse.events.map((e) => e.id),
    'compiling in the other order produced different ids',
  );
  assert.equal(new Set(forward.events.map((e) => e.id)).size, forward.events.length);
});

test('a source ending before it starts is reported and skipped', () => {
  const source = aSource('expense', {
    id: 'backwards', name: 'Backwards', startDate: '2026-06-01', endDate: '2026-01-01',
    details: { amount: 100_00, frequency: 'monthly' },
  });
  const { events, warnings } = compileOne(source);

  assert.equal(events.length, 0);
  const warning = warnings.find((w) => w.code === 'source.end_before_start');
  assert.ok(warning);
  assert.equal(warning.severity, 'error');
});

test('a compiler cannot reach the ledger, other sources, or the clock', () => {
  // Enforced by construction: the context simply does not expose them. This registers a
  // probe type to capture exactly what compile() is handed.
  let captured = null;

  registerSourceType({
    type: '__probe__',
    label: 'Probe',
    family: 'expense',
    fields: [{ path: 'name', label: 'Name', kind: 'text' }],
    overridablePaths: ['name'],
    defaults: () => ({
      id: '', type: '__probe__', name: 'probe', enabled: true, personId: null,
      startDate: '2026-01-01', endDate: null,
      certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
      details: {}, notes: '',
    }),
    compile: (_source, ctx) => { captured = ctx; },
  });

  compileAll([aSource('__probe__', { id: 'probe1' })], { horizon: YEAR_2026 });

  assert.ok(captured, 'the probe compiler did not run');
  assert.deepEqual(
    Object.keys(captured).sort(),
    ['assumptions', 'emit', 'emitGroup', 'helpers', 'horizon', 'household', 'rules', 'warn', 'window'],
    'the compile context gained or lost a key',
  );
  for (const forbidden of ['balances', 'sources', 'today', 'ledger', 'now', 'months']) {
    assert.equal(captured[forbidden], undefined, `a compiler must not be able to read "${forbidden}"`);
  }
  assert.ok(Object.isFrozen(captured), 'the context must not be mutable by a compiler');
});
