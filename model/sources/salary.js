/**
 * W-2 salary.
 *
 * A paycheck is emitted as several legs sharing one `groupId`, never as one event with
 * sub-amounts. See the frozen-field-list note in types.js for why:
 *
 *   gross pay          INCOME_GROSS       cash +G   taxable +G   w2_wages
 *   pre-tax deferral   PRETAX_DEDUCTION   cash -D   taxable -D   pretax_deferral
 *   federal withheld   WITHHOLDING        cash -F   taxable  0
 *   FICA withheld      WITHHOLDING        cash -S   taxable  0
 *
 * Withholding here is a flat percentage. The rule-pack-driven version arrives in
 * Milestone C and replaces this; the tests written against it must survive that swap.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { NOMINAL_PER_YEAR, elapsedMonths, expandSchedule } from '../recurrence.js';
import { scaleCents, sumCents } from '../money.js';
import { toPeriod } from '../dates.js';

/**
 * Tags marking withholding that PREPAYS the income tax bill, as opposed to payroll tax.
 * `tax/index.js` reconciles against exactly these.
 */
export const INCOME_TAX_WITHHOLDING_TAGS = Object.freeze(['income-tax', 'tax', 'withholding']);

export const SALARY_DEFAULTS = Object.freeze({
  annualAmount: 0,
  frequency: 'semimonthly',
  growthRate: 0.03,
  growthMode: 'annual-step',
  federalWithholdingRate: 0.18,
  ficaRate: 0.0765,
  preTaxRate: 0,
  retirementAccount: 'retirement',
  account: 'cash',
  businessDayRule: 'none',
});

const FIELDS = [
  { path: 'name', label: 'Employer', kind: 'text', required: true },
  { path: 'details.annualAmount', label: 'Annual salary', kind: 'money', required: true, min: 0 },
  { path: 'startDate', label: 'Start date', kind: 'date', required: true },
  { path: 'endDate', label: 'End date', kind: 'date', help: 'Leave blank if ongoing.' },
  {
    path: 'details.frequency', label: 'Pay frequency', kind: 'select', required: true,
    options: [
      { value: 'weekly', label: 'Weekly' },
      { value: 'biweekly', label: 'Every two weeks' },
      { value: 'semimonthly', label: 'Twice a month' },
      { value: 'monthly', label: 'Monthly' },
    ],
    help: 'Every two weeks means 26 or 27 paychecks a year — the model counts the real dates.',
  },
  { path: 'details.growthRate', label: 'Annual raise', kind: 'percent', min: -1, max: 1 },
  {
    path: 'details.growthMode', label: 'How the raise applies', kind: 'select', advanced: true,
    options: [
      { value: 'annual-step', label: 'All at once on the anniversary' },
      { value: 'monthly-compound', label: 'Spread smoothly through the year' },
      { value: 'none', label: 'No growth' },
    ],
  },
  { path: 'details.preTaxRate', label: 'Pre-tax retirement contribution', kind: 'percent', min: 0, max: 1,
    help: 'Percentage of gross pay. Reduces both take-home pay and taxable income.' },
  { path: 'details.federalWithholdingRate', label: 'Federal withholding', kind: 'percent', min: 0, max: 1, advanced: true },
  { path: 'details.ficaRate', label: 'Social Security and Medicare', kind: 'percent', min: 0, max: 1, advanced: true,
    help: 'The employee side, 7.65% up to the wage base. Replaced by the tax rule pack later.' },
  { path: 'details.account', label: 'Paid into', kind: 'text', advanced: true },
  { path: 'details.retirementAccount', label: 'Retirement account', kind: 'text', advanced: true },
];

function check(source) {
  const warnings = [];
  const d = source.details;

  if (d.annualAmount < 0) {
    warnings.push(makeWarning('source.negative_amount',
      { name: source.name, field: 'annual salary' }, source.id));
  }
  if (d.annualAmount === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
  }

  const deductions = (d.federalWithholdingRate ?? 0) + (d.ficaRate ?? 0) + (d.preTaxRate ?? 0);
  if (deductions >= 1) {
    warnings.push(makeWarning('source.withholding_exceeds_gross',
      { name: source.name, withholdingPct: Math.round(deductions * 100) }, source.id));
  }
  return warnings;
}

/**
 * Growth is applied per paycheck from the source's own start date, so a raise lands on the
 * employment anniversary rather than on 1 January.
 */
function compile(source, ctx) {
  const d = { ...SALARY_DEFAULTS, ...source.details };
  if (d.annualAmount === 0) return;

  const dates = expandSchedule({
    start: source.startDate,
    end: source.endDate,
    frequency: d.frequency,
    businessDayRule: d.businessDayRule,
    windowStart: ctx.horizon.startDate,
    windowEnd: ctx.horizon.endDate,
  });
  if (dates.length === 0) return;

  // Per-paycheck gross is the annual rate divided by the number of pay periods in a
  // NOMINAL year, which is how payroll actually works — not by however many paychecks
  // happen to fall inside the projection window. Dividing by the latter would pay a
  // six-month job a full year's salary.
  //
  // A consequence worth keeping rather than smoothing away: a biweekly year with 27
  // paychecks pays 27 x (annual / 26), slightly more than the stated salary. That extra
  // cheque is real money in a real year, and people plan around it.
  const periodsPerYear = NOMINAL_PER_YEAR[d.frequency];
  if (!periodsPerYear) {
    throw new Error(`salary: no nominal period count for frequency "${d.frequency}"`);
  }

  for (const date of dates) {
    const months = Math.max(0, elapsedMonths(source.startDate, date));
    const annual = ctx.helpers.applyGrowth(d.annualAmount, d.growthRate, months, d.growthMode);
    const gross = scaleCents(annual, 1 / periodsPerYear);
    if (gross === 0) continue;

    const preTax = scaleCents(gross, d.preTaxRate);
    const taxableWages = gross - preTax;
    const federal = scaleCents(taxableWages, d.federalWithholdingRate);
    const fica = scaleCents(gross, d.ficaRate);

    const groupId = `pay:${source.id}:${date}`;
    const legs = [];

    legs.push({
      date, kind: 'income', phase: 'INCOME_GROSS', account: d.account,
      cashAmount: gross, taxableAmount: gross, taxCategory: 'w2_wages',
      category: 'salary', label: `${source.name} — gross pay`,
      tags: ['earned-income', 'w2'],
    });

    if (preTax > 0) {
      // Two legs: cash leaves the paycheck, the retirement account receives it. The
      // taxable reduction rides on the cash leg.
      legs.push({
        date, kind: 'contribution', phase: 'PRETAX_DEDUCTION', account: d.account,
        cashAmount: -preTax, taxableAmount: -preTax, taxCategory: 'pretax_deferral',
        category: 'retirement', label: `${source.name} — pre-tax retirement`,
        tags: ['pretax', 'retirement'],
      });
      legs.push({
        date, kind: 'contribution', phase: 'PRETAX_DEDUCTION', account: d.retirementAccount,
        cashAmount: preTax, taxableAmount: 0, taxCategory: null,
        category: 'retirement', label: `${source.name} — into retirement`,
        tags: ['pretax', 'retirement'],
      });
    }

    // The two withholdings are tagged apart because they reconcile differently. Federal
    // income tax withholding is a PREPAYMENT against the year's liability and settles up
    // in April. Employee FICA is a separate, final tax — it never appears on the return
    // (bar excess Social Security across two employers). Counting FICA as income tax
    // withholding inflates the refund by the whole of it.
    if (federal > 0) {
      legs.push({
        date, kind: 'withholding', phase: 'WITHHOLDING', account: d.account,
        cashAmount: -federal, category: 'tax',
        label: `${source.name} — federal withholding`,
        tags: [...INCOME_TAX_WITHHOLDING_TAGS],
      });
    }
    if (fica > 0) {
      legs.push({
        date, kind: 'withholding', phase: 'WITHHOLDING', account: d.account,
        cashAmount: -fica, category: 'tax',
        label: `${source.name} — Social Security and Medicare`,
        tags: ['fica', 'payroll-tax', 'tax', 'withholding'],
      });
    }

    // One groupId for the whole paycheck, so `netPayFor` and the attribution narrative see
    // it as a single transaction. The contribution pair goes through emitGroup so its two
    // legs are checked to balance; the income and withholding legs are not part of that
    // check (a paycheck as a whole is not net-zero — that is the point of it).
    for (const leg of legs) {
      if (leg.kind === 'contribution') continue;
      ctx.emit({ ...leg, groupId });
    }
    const contributions = legs.filter((leg) => leg.kind === 'contribution');
    if (contributions.length > 0) ctx.emitGroup(groupId, contributions);
  }
}

function describe(source) {
  const d = { ...SALARY_DEFAULTS, ...source.details };
  const dollars = (d.annualAmount / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return `${dollars} a year, paid ${d.frequency}`;
}

export const salaryType = registerSourceType({
  type: 'salary',
  // The two types a simple plan is built from.
  complexity: 'simple',
  label: 'Salary / W-2 job',
  family: 'income',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.annualAmount', 'details.frequency', 'details.growthRate', 'details.growthMode',
    'details.preTaxRate', 'details.federalWithholdingRate', 'details.ficaRate',
  ],
  defaults: () => ({
    id: '', type: 'salary', name: 'New job', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...SALARY_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});

/** Exported for tests: total gross a salary source pays in a calendar year. */
export function grossInYear(events, sourceId, year) {
  return sumCents(
    events
      .filter((e) => e.sourceId === sourceId && e.kind === 'income' && toPeriod(e.date).startsWith(String(year)))
      .map((e) => e.cashAmount),
  );
}
