/**
 * Recurring and one-off expenses.
 *
 * Carries `essential` and `cutPriority`, which feed the emergency-fund calculation (months
 * of ESSENTIAL spending, not all spending) and the discretionary-cut stress scenario.
 *
 * Sinking funds arrive in Milestone B. The shape is declared here so the field exists in
 * saved models from the start.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { elapsedMonths, expandSchedule } from '../recurrence.js';
import { allocate } from '../money.js';
import { addPeriods, periodToISO, periodsBetween, toPeriod } from '../dates.js';
import { SINKING_PREFIX } from '../close-rules.js';

export const EXPENSE_DEFAULTS = Object.freeze({
  amount: 0,
  frequency: 'monthly',
  inflationRate: 0.03,
  growthMode: 'monthly-compound',
  category: 'general',
  essential: false,
  cutPriority: 3,
  account: 'cash',
  anchorDay: null,
  businessDayRule: 'none',
  sinkingFund: { enabled: false },
});

export const EXPENSE_CATEGORIES = Object.freeze([
  'housing', 'utilities', 'groceries', 'transport', 'healthcare', 'insurance', 'childcare',
  'education', 'debt', 'subscriptions', 'dining', 'travel', 'charitable', 'personal',
  'business', 'property', 'general',
]);

const FIELDS = [
  { path: 'name', label: 'Name', kind: 'text', required: true },
  { path: 'details.amount', label: 'Amount', kind: 'money', required: true, min: 0 },
  {
    path: 'details.frequency', label: 'How often', kind: 'select', required: true,
    options: [
      { value: 'monthly', label: 'Monthly' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'biweekly', label: 'Every two weeks' },
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'semiannual', label: 'Twice a year' },
      { value: 'annual', label: 'Annually' },
      { value: 'once', label: 'One-off' },
    ],
  },
  { path: 'startDate', label: 'Starts', kind: 'date', required: true },
  { path: 'endDate', label: 'Ends', kind: 'date', help: 'Leave blank if ongoing.' },
  {
    path: 'details.category', label: 'Category', kind: 'select',
    options: EXPENSE_CATEGORIES.map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) })),
  },
  {
    path: 'details.essential', label: 'Essential', kind: 'bool',
    help: 'Essential spending drives the emergency-fund target. Rent is; streaming is not.',
  },
  {
    path: 'details.cutPriority', label: 'Cut first (1) to last (5)', kind: 'int', min: 1, max: 5,
    advanced: true, help: 'Used by the belt-tightening scenario.',
  },
  { path: 'details.inflationRate', label: 'Grows by', kind: 'percent', min: -1, max: 1 },
  {
    path: 'details.growthMode', label: 'How growth applies', kind: 'select', advanced: true,
    options: [
      { value: 'monthly-compound', label: 'Smoothly (typical for prices)' },
      { value: 'annual-step', label: 'All at once each year (typical for rent)' },
      { value: 'none', label: 'No growth' },
    ],
  },
  { path: 'details.anchorDay', label: 'Day of month', kind: 'int', min: 1, max: 31, advanced: true },
  { path: 'details.account', label: 'Paid from', kind: 'text', advanced: true },
  {
    path: 'details.sinkingFund.enabled', label: 'Save up for this monthly', kind: 'bool',
    help: 'Spreads an irregular bill into a monthly reserve. The bill still lands on its real date — you just see the money set aside in advance rather than a sudden drop.',
  },
];

function check(source) {
  const warnings = [];
  const d = source.details;
  if (d.amount < 0) {
    warnings.push(makeWarning('source.negative_amount', { name: source.name, field: 'amount' }, source.id));
  }
  if (d.amount === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
  }
  return warnings;
}

function compile(source, ctx) {
  const d = { ...EXPENSE_DEFAULTS, ...source.details };
  if (d.amount === 0) return;

  const dates = expandSchedule({
    start: source.startDate,
    end: source.endDate,
    frequency: d.frequency,
    anchorDay: d.anchorDay,
    businessDayRule: d.businessDayRule,
    windowStart: ctx.horizon.startDate,
    windowEnd: ctx.horizon.endDate,
  });

  const sinking = d.sinkingFund?.enabled === true;
  const fundAccount = sinking ? `${SINKING_PREFIX}${source.id}` : d.account;

  const bills = [];
  for (const date of dates) {
    const months = Math.max(0, elapsedMonths(source.startDate, date));
    const amount = ctx.helpers.applyGrowth(d.amount, d.inflationRate, months, d.growthMode);
    if (amount === 0) continue;

    bills.push({ date, amount });

    // The bill itself is UNCHANGED in date and amount whether or not it is sinking-funded.
    // Only the account it is paid from moves. That is what keeps expense totals identical
    // between the two setups — see the double-count note below.
    ctx.emit({
      date,
      kind: 'expense',
      phase: 'EXPENSE',
      account: fundAccount,
      cashAmount: -amount,
      category: d.category,
      essential: Boolean(d.essential),
      cutPriority: d.cutPriority ?? null,
      label: source.name,
      tags: d.essential ? ['essential'] : ['discretionary'],
    });
  }

  if (sinking && bills.length > 0) emitReserveLegs(source, ctx, d, fundAccount, bills);
}

/**
 * Monthly reserve legs for a sinking fund.
 *
 * A SINKING FUND IS A TRANSFER, NEVER AN EXPENSE. That single decision is what makes the
 * arithmetic safe:
 *
 *   - Expense totals are `Σ cashAmount where kind === 'expense'`. Transfers are excluded
 *     by kind, so the bill is counted exactly once, on its real date.
 *   - A transfer group sums to zero, so net worth is bit-identical with and without the
 *     fund.
 *   - Bank cash correctly drops by the monthly reserve instead of the whole bill, which is
 *     the entire point.
 *
 * Reserving is spread across the months leading up to each bill, using `allocate` so the
 * legs sum to the bill exactly rather than leaving a cent behind.
 */
function emitReserveLegs(source, ctx, d, fundAccount, bills) {
  // Saving starts at the beginning of the projection, not at the source's own start date —
  // for an annual bill those are the same date, and reserving "from the bill" would save
  // nothing at all before it lands.
  let fromPeriod = toPeriod(ctx.horizon.startDate);

  for (const bill of bills) {
    const billPeriod = toPeriod(bill.date);

    // Reserve only in months STRICTLY BEFORE the bill's own month. The reserve leg sits in
    // the TRANSFER phase, which sorts after EXPENSE, so a same-month contribution would
    // arrive after the bill had already been paid and trigger a spurious top-up.
    const periods = [];
    for (let p = fromPeriod; periodsBetween(p, billPeriod) > 0; p = addPeriods(p, 1)) {
      const date = periodToISO(p, 'last');
      if (date >= ctx.horizon.startDate && date <= ctx.horizon.endDate) periods.push(p);
    }

    if (periods.length === 0) {
      // No runway. Rather than pretending, say so — the auto-cover rule will take the
      // money from cash on the day and report that too.
      ctx.warn('sinking.underfunded_at_due', {
        perMonth: '$0',
        target: (bill.amount / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' }),
        dueDate: bill.date,
      });
      fromPeriod = addPeriods(billPeriod, 1);
      continue;
    }

    const shares = allocate(bill.amount, periods.map(() => 1));

    periods.forEach((period, index) => {
      const amount = shares[index];
      if (amount === 0) return;

      ctx.emitGroup(`sink:${source.id}:${period}`, [
        {
          date: periodToISO(period, 'last'),
          kind: 'transfer', phase: 'TRANSFER', account: d.account,
          cashAmount: -amount, category: d.category,
          label: `${source.name} — set aside`, tags: ['sinking-fund', 'transfer'],
        },
        {
          date: periodToISO(period, 'last'),
          kind: 'transfer', phase: 'TRANSFER', account: fundAccount,
          cashAmount: amount, category: d.category,
          label: `${source.name} — reserve`, tags: ['sinking-fund', 'transfer'],
        },
      ]);
    });

    fromPeriod = addPeriods(billPeriod, 1);
  }
}

function describe(source) {
  const d = { ...EXPENSE_DEFAULTS, ...source.details };
  const dollars = (d.amount / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return `${dollars} ${d.frequency}${d.essential ? ', essential' : ''}`;
}

export const expenseType = registerSourceType({
  type: 'expense',
  complexity: 'simple',
  label: 'Expense',
  family: 'expense',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.amount', 'details.frequency', 'details.inflationRate', 'details.growthMode',
    'details.essential', 'details.cutPriority', 'details.category',
    'details.sinkingFund.enabled',
  ],
  defaults: () => ({
    id: '', type: 'expense', name: 'New expense', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...EXPENSE_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});
