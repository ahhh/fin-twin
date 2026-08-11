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

/* ---- royalty ---- */

test('a royalty statement is paid long after the period it reports on', () => {
  // The lag is the point of the type. Booking a Q1 statement as Q1 cash is the reason a
  // royalty projection looks comfortable six months before the money actually turns up.
  const source = aSource('royalty', {
    id: 'book', personId: 'p1', name: 'Book', startDate: '2026-01-01', endDate: '2026-12-31',
    details: { amount: 4_500_00, frequency: 'quarterly', statementLagDays: 90 },
  });
  const { events } = compileOne(source);

  assert.deepEqual(events.map((e) => e.date), ['2026-04-01', '2026-06-30', '2026-09-29', '2026-12-30']);
  assert.equal(events[0].meta.statementDate, '2026-01-01', 'the period it reports on is kept');
  assert.equal(events[0].taxCategory, 'se_net_profit', 'your own work carries SE tax');
  assert.ok(events[0].tags.includes('variable-income'),
    'without this tag a royalty counts as dependable income in the concentration metric');
});

test('a royalty on work you did not create is ordinary income, not self-employment', () => {
  // Roughly 15% of the money rides on this distinction, so it is a field rather than
  // an assumption.
  const source = aSource('royalty', {
    id: 'catalogue', personId: 'p1', name: 'Inherited catalogue',
    startDate: '2026-01-01', endDate: '2026-01-01',
    details: { amount: 1_000_00, frequency: 'once', statementLagDays: 0, selfEmployment: false },
  });
  const { events } = compileOne(source);

  assert.equal(events.length, 1);
  assert.equal(events[0].taxCategory, 'other_ordinary');
});

test('a royalty carries its range on the event rather than pre-picking an amount', () => {
  // Same reasoning as the contract's probability: one compiled stream has to serve the
  // good, ordinary and bad runs, so the compiler emits the base and hands over the ends.
  const source = aSource('royalty', {
    id: 'book', personId: 'p1', name: 'Book', startDate: '2026-01-01', endDate: '2026-01-01',
    details: {
      amount: 4_500_00, lowAmount: 2_000_00, highAmount: 9_000_00,
      frequency: 'once', statementLagDays: 0,
    },
  });
  const { events } = compileOne(source);

  assert.equal(events[0].cashAmount, 4_500_00, 'the base amount, not an end of the range');
  assert.deepEqual(events[0].meta.range, { low: 2_000_00, base: 4_500_00, high: 9_000_00 });
});

test('a royalty range with only one end given falls back to the base for the other', () => {
  const source = aSource('royalty', {
    id: 'book', personId: 'p1', startDate: '2026-01-01', endDate: '2026-01-01',
    details: { amount: 4_500_00, lowAmount: 2_000_00, frequency: 'once', statementLagDays: 0 },
  });
  const { events } = compileOne(source);

  assert.deepEqual(events[0].meta.range, { low: 2_000_00, base: 4_500_00, high: 4_500_00 },
    '"I know it could be bad but not how good" should not require inventing a number');
});

test('a royalty range the wrong way round is reported as an error', () => {
  const source = aSource('royalty', {
    id: 'book', personId: 'p1', name: 'Book', startDate: '2026-01-01', endDate: '2026-01-01',
    details: { amount: 4_500_00, lowAmount: 9_000_00, highAmount: 2_000_00, frequency: 'once' },
  });
  const { warnings } = compileOne(source);

  const warning = warnings.find((w) => w.code === 'royalty.range_inverted');
  assert.ok(warning, 'an inverted range would silently swap the optimistic and pessimistic runs');
  assert.equal(warning.severity, 'error');
});

/* ---- fixed contract ---- */

test('a named empty month produces no payment', () => {
  const source = aSource('fixed_contract', {
    id: 'flat', personId: 'p1', name: 'Flat 2B', startDate: '2026-01-01', endDate: '2026-12-31',
    details: {
      amount: 1_800_00, frequency: 'monthly', growthRate: 0,
      gapMonths: '2026-03, 2026-07..2026-08',
    },
  });
  const { events } = compileOne(source);

  assert.equal(events.length, 9, 'twelve months less a void and a two-month run');
  assert.deepEqual(
    events.map((e) => e.date.slice(0, 7)),
    ['2026-01', '2026-02', '2026-04', '2026-05', '2026-06', '2026-09', '2026-10', '2026-11', '2026-12'],
  );
  assert.equal(sumCash(events), 9 * 1_800_00);
  assert.equal(events[0].taxCategory, 'rental_net');
});

test('a gap is tested against the month the rent was due, not the month it lands', () => {
  // A void in March is March's missing rent whatever the payment terms say. Testing the
  // paid date instead would skip April's rent and pay March's.
  const source = aSource('fixed_contract', {
    id: 'flat', personId: 'p1', startDate: '2026-01-01', endDate: '2026-04-30',
    details: {
      amount: 1_000_00, frequency: 'monthly', growthRate: 0,
      paymentLagDays: 35, gapMonths: '2026-03',
    },
  });
  const { events } = compileOne(source);

  assert.deepEqual(events.map((e) => e.meta.dueDate), ['2026-01-01', '2026-02-01', '2026-04-01']);
  assert.deepEqual(events.map((e) => e.date), ['2026-02-05', '2026-03-08', '2026-05-06'],
    'March receives February rent even though March itself is a void');
});

test('an unreadable gap is reported rather than silently ignored', () => {
  // Silently dropping it would show rent arriving in a month the user had said was empty.
  const source = aSource('fixed_contract', {
    id: 'flat', personId: 'p1', name: 'Flat 2B', startDate: '2026-01-01', endDate: '2026-06-30',
    details: { amount: 1_000_00, frequency: 'monthly', gapMonths: '2026-03, Marchish, 2026-13' },
  });
  const { events, warnings } = compileOne(source);

  const warning = warnings.find((w) => w.code === 'source.unreadable_gap');
  assert.ok(warning);
  assert.match(warning.message, /Marchish/);
  assert.equal(events.length, 5, 'the month it could read is still honoured');
});

test('a fixed contract raises on the anniversary of the agreement, not in January', () => {
  const source = aSource('fixed_contract', {
    id: 'flat', personId: 'p1', startDate: '2026-07-01', endDate: '2027-12-31',
    details: { amount: 1_000_00, frequency: 'annual', growthRate: 0.05, growthMode: 'annual-step' },
  });
  const { events } = compileOne(source, makeHorizon('2026-01-01', '2027-12-31'));

  assert.deepEqual(events.map((e) => e.date), ['2026-07-01', '2027-07-01']);
  assert.deepEqual(events.map((e) => e.cashAmount), [1_000_00, 1_050_00]);
});

/* ---- windfall ---- */

test('an inheritance moves cash without ever reaching the tax return', () => {
  // Taxing a $200k inheritance as ordinary income invents roughly $60k of tax that does
  // not exist, and every month after it is then wrong.
  const source = aSource('windfall', {
    id: 'inh', personId: 'p1', name: 'Inheritance', startDate: '2026-05-01',
    certainty: { mode: 'fixed', confidence: 1 },
    details: { amount: 200_000_00, treatment: 'inheritance' },
  });
  const { events } = compileOne(source);

  assert.equal(events.length, 1);
  assert.equal(events[0].cashAmount, 200_000_00);
  assert.equal(events[0].taxableAmount, 0);
  assert.equal(events[0].taxCategory, null, 'taxable and category are all-or-nothing');
});

test('a withheld bonus shares one group with its withholding, so it is not reserved for twice', () => {
  const source = aSource('windfall', {
    id: 'bonus', personId: 'p1', name: 'Bonus', startDate: '2026-03-15',
    certainty: { mode: 'fixed', confidence: 1 },
    details: { amount: 20_000_00, treatment: 'bonus', withholdingRate: 0.22 },
  });
  const { events } = compileOne(source);

  assert.equal(events.length, 2);
  assert.equal(events[0].taxCategory, 'w2_wages');
  assert.equal(netPayFor(events, events[0].groupId), 15_600_00, '$20k less 22%');
  assert.equal(events[1].groupId, events[0].groupId,
    'the tax reserve rule keys off the group; splitting them would reserve for tax already withheld');
});

test('a windfall is possible rather than certain by default', () => {
  // A plan that only works if the inheritance arrives is a plan worth seeing without it.
  const blank = aSource('windfall', {});
  assert.equal(blank.certainty.mode, 'probability');
  assert.equal(blank.certainty.confidence, 0.5);
});

test('withholding on money that is not income is reported', () => {
  const source = aSource('windfall', {
    id: 'gift', personId: 'p1', name: 'Gift', startDate: '2026-05-01',
    details: { amount: 10_000_00, treatment: 'gift', withholdingRate: 0.2 },
  });
  const { warnings } = compileOne(source);

  const warning = warnings.find((w) => w.code === 'windfall.withholding_on_untaxed');
  assert.ok(warning, 'it would otherwise count as tax the user had already paid');
});

test('a windfall with no person keeps its withholding rather than emitting an invalid event', () => {
  // The Social Security wage base is per person, so events.js refuses an unattributed
  // withholding leg. Warning and paying whole beats throwing on ordinary user data.
  const source = aSource('windfall', {
    id: 'bonus', personId: null, name: 'Bonus', startDate: '2026-03-15',
    details: { amount: 10_000_00, treatment: 'bonus', withholdingRate: 0.22 },
  });
  const { events, warnings } = compileOne(source);

  assert.equal(events.filter((e) => e.kind === 'withholding').length, 0);
  assert.ok(warnings.find((w) => w.code === 'windfall.withholding_without_person'));
});

/* ---- investment income ---- */

test('investment income accrues on actual days, not a nominal quarter', () => {
  // Q1 covers 90 days and Q3 covers 92. Dividing the annual rate by four instead would
  // quietly accumulate into a wrong year-end.
  const source = aSource('investment_income', {
    id: 'brokerage', personId: 'p1', startDate: '2026-01-01', endDate: '2026-12-31',
    details: {
      balance: 250_000_00, yieldRate: 0.042, frequency: 'quarterly',
      incomeType: 'qualified_dividends',
    },
  });
  const { events } = compileOne(source);

  assert.deepEqual(events.map((e) => e.date), ['2026-04-01', '2026-07-01', '2026-10-01'],
    'the first payment falls a whole quarter after the money went in, not on day one');
  assert.deepEqual(events.map((e) => e.meta.daysAccrued), [90, 91, 92]);
  assert.deepEqual(events.map((e) => e.cashAmount), [2_589_04, 2_617_81, 2_646_58]);
  assert.equal(events[0].taxCategory, 'qualified_dividends');
});

test('municipal interest is income that is never taxed', () => {
  const source = aSource('investment_income', {
    id: 'munis', personId: 'p1', startDate: '2026-01-01', endDate: '2027-12-31',
    details: { balance: 100_000_00, yieldRate: 0.03, frequency: 'annual', incomeType: 'tax_exempt_interest' },
  });
  const { events } = compileOne(source, makeHorizon('2026-01-01', '2027-12-31'));

  assert.ok(events.length > 0);
  assert.equal(events[0].taxCategory, 'tax_exempt_interest',
    'exempt is a bucket of its own — it is reported, then not taxed');
  assert.ok(events[0].taxableAmount > 0, 'exempt interest is still taxable-amount-bearing income');
});

test('reinvesting does not defer the tax', () => {
  // The squeeze this exists to show: you owe tax on money that never sat still. Modelling
  // reinvestment as "nothing happened" hides it completely.
  const source = aSource('investment_income', {
    id: 'fund', personId: 'p1', startDate: '2026-01-01', endDate: '2026-12-31',
    details: {
      balance: 100_000_00, yieldRate: 0.10, frequency: 'semiannual',
      incomeType: 'interest', reinvest: true,
    },
  });
  const { events } = compileOne(source);

  const income = events.filter((e) => e.kind === 'income');
  const transfers = events.filter((e) => e.kind === 'transfer');

  assert.equal(income.length, 1);
  assert.equal(income[0].taxableAmount, 4_958_90, 'taxed in the year it was paid');
  assert.equal(sumCash(transfers), 0, 'the reinvestment is net-zero');
  assert.equal(sumCash(events, (e) => e.account === 'cash'), 0,
    'nothing spendable arrived — it came in and went straight back out');
  assert.equal(sumCash(events, (e) => e.account === 'fund'), 4_958_90, 'the holding grew instead');
  assert.equal(sumTaxable(events), 4_958_90, 'and the tax is owed on it anyway');
});

test('a yield typed as 8 rather than 0.08 is called out', () => {
  const source = aSource('investment_income', {
    id: 'savings', personId: 'p1', name: 'Savings', startDate: '2026-01-01',
    details: { balance: 10_000_00, yieldRate: 8, frequency: 'annual', incomeType: 'interest' },
  });
  const { warnings } = compileOne(source);

  assert.ok(warnings.find((w) => w.code === 'investment.implausible_yield'),
    'it would otherwise quietly produce a plan that works');
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
