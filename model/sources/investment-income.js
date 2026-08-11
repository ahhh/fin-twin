/**
 * Income thrown off by money you already have — interest and dividends.
 *
 * This is the other half of `asset.js`. That type models what you put in and what you get
 * when you sell; this one models what the holding pays you while you hold it. They are
 * separate because the tax is separate: a sale produces a capital gain, taxed once, at
 * preferential rates if you held it long enough. A dividend is taxed every year whether
 * or not you touch it.
 *
 * Four kinds of yield, four different answers on a tax return, and the app already has a
 * category for each:
 *
 *   interest              savings, CDs, most bonds — ordinary rates, no favour
 *   ordinary_dividends    REITs, most funds — ordinary rates
 *   qualified_dividends   most US stocks held long enough — preferential rates
 *   tax_exempt_interest   municipal bonds — not federally taxed at all
 *
 * REINVESTING DOES NOT DEFER THE TAX, and modelling it as if it did is the mistake this
 * type exists to prevent. A reinvested dividend is income you received and then chose to
 * spend on more shares. So it is emitted as taxable income arriving in cash, followed by
 * a net-zero transfer back into the holding. The tax reserve then earmarks cash for a
 * bill on money that never sat still — which is exactly the squeeze real investors hit,
 * and it is invisible if you model reinvestment as "nothing happened".
 *
 * Accrual is by ACTUAL DAYS between payments, not by dividing the annual rate by a
 * nominal period count. A quarterly payer's Q1 covers 90 days and its Q3 covers 92, and
 * the difference is the sort of thing that quietly accumulates into a wrong year-end.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { expandSchedule } from '../recurrence.js';
import { scaleCents } from '../money.js';
import { addMonths, daysBetween, isAfter } from '../dates.js';

/** How far after the start date the first payment falls, by frequency. */
const MONTH_STEP = Object.freeze({ monthly: 1, quarterly: 3, semiannual: 6, annual: 12 });

/** Interest accrues on a 365-day year here; the half-day of a leap year is noise. */
const DAYS_PER_YEAR = 365;

export const INVESTMENT_INCOME_DEFAULTS = Object.freeze({
  balance: 0,
  yieldRate: 0,
  frequency: 'quarterly',
  incomeType: 'interest',
  reinvest: false,
  account: 'cash',
  holdingAccount: '',   // defaults to the source id, as asset.js does
});

const FIELDS = [
  { path: 'name', label: 'What it is', kind: 'text', required: true },
  {
    path: 'details.balance', label: 'Amount invested', kind: 'money', required: true, min: 0,
    help: 'The balance the yield is earned on, not what it is worth today.',
  },
  {
    path: 'details.yieldRate', label: 'Annual yield', kind: 'percent', required: true, min: 0, max: 1,
    help: 'The income rate only — dividends or interest. Price growth is not income and is not modelled here.',
  },
  {
    path: 'details.frequency', label: 'Paid', kind: 'select', required: true,
    options: [
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'monthly', label: 'Monthly' },
      { value: 'semiannual', label: 'Twice a year' },
      { value: 'annual', label: 'Annually' },
    ],
  },
  { path: 'startDate', label: 'Held from', kind: 'date', required: true },
  { path: 'endDate', label: 'Held until', kind: 'date', help: 'Leave blank if ongoing.' },
  {
    path: 'details.incomeType', label: 'Taxed as', kind: 'select', required: true,
    options: [
      { value: 'interest', label: 'Interest — savings, CDs, bonds' },
      { value: 'ordinary_dividends', label: 'Ordinary dividends — REITs, many funds' },
      { value: 'qualified_dividends', label: 'Qualified dividends — most US shares' },
      { value: 'tax_exempt_interest', label: 'Tax-exempt interest — municipal bonds' },
    ],
  },
  {
    path: 'details.reinvest', label: 'Reinvest it', kind: 'bool',
    help: 'You still owe the tax in the year it is paid, even though the cash never reaches you. The model shows that.',
  },
  { path: 'details.account', label: 'Paid into', kind: 'text', advanced: true },
  { path: 'details.holdingAccount', label: 'Holding account', kind: 'text', advanced: true },
];

const INCOME_TYPES = new Set(['interest', 'ordinary_dividends', 'qualified_dividends', 'tax_exempt_interest']);

function check(source) {
  const warnings = [];
  const d = { ...INVESTMENT_INCOME_DEFAULTS, ...source.details };

  if (d.balance < 0) {
    warnings.push(makeWarning('source.negative_amount', { name: source.name, field: 'amount invested' }, source.id));
  }
  if (d.balance === 0 || d.yieldRate === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
  }
  if (!INCOME_TYPES.has(d.incomeType)) {
    warnings.push(makeWarning('investment.unknown_income_type',
      { name: source.name, incomeType: d.incomeType }, source.id));
  }
  // A yield this high is nearly always a rate typed as 8 rather than 0.08, and it would
  // otherwise quietly produce a plan that works.
  if (d.yieldRate > 0.5) {
    warnings.push(makeWarning('investment.implausible_yield',
      { name: source.name, rate: Math.round(d.yieldRate * 100) }, source.id));
  }
  return warnings;
}

function compile(source, ctx) {
  const d = { ...INVESTMENT_INCOME_DEFAULTS, ...source.details };
  if (d.balance === 0 || d.yieldRate === 0) return;
  if (!INCOME_TYPES.has(d.incomeType)) return;

  const holdingAccount = d.holdingAccount || source.id;
  const probability = source.certainty?.mode === 'probability'
    ? (source.certainty.confidence ?? 1)
    : 1;

  // The first payment falls one whole period after the money went in, not on the day it
  // did. Starting the schedule at the start date would emit a payment covering no days.
  const firstPayout = addMonths(source.startDate, MONTH_STEP[d.frequency] ?? 3);

  // Held for less than one payment period — an annual payer bought in June, say. Nothing
  // has been declared yet, so there is nothing to emit. Returning here rather than letting
  // `expandSchedule` see a reversed window matters: that would throw, and a compiler must
  // not throw on data a user can legitimately enter.
  const lastPossible = source.endDate ?? ctx.horizon.endDate;
  if (isAfter(firstPayout, lastPossible)) return;

  const payoutDates = expandSchedule({
    start: firstPayout,
    end: source.endDate,
    frequency: d.frequency,
    businessDayRule: 'none',
    windowStart: firstPayout,
    windowEnd: source.endDate ?? ctx.horizon.endDate,
  });

  // Reinvestment compounds the balance this compiler carries. That stays a pure function
  // of one source — it is arithmetic over this source's own payments, not a reading of
  // any running ledger balance, which a compiler is not allowed to do.
  let balance = d.balance;
  let accruedFrom = source.startDate;

  for (const date of payoutDates) {
    const days = daysBetween(accruedFrom, date);
    accruedFrom = date;
    if (days <= 0) continue;

    const amount = scaleCents(balance, (d.yieldRate * days) / DAYS_PER_YEAR);
    if (amount === 0) continue;
    if (d.reinvest) balance += amount;

    ctx.emit({
      date,
      kind: 'income',
      phase: 'INCOME_GROSS',
      account: d.account,
      cashAmount: amount,
      taxableAmount: amount,
      taxCategory: d.incomeType,
      category: 'investment-income',
      probability,
      label: `${source.name} — ${d.incomeType === 'interest' ? 'interest' : 'dividend'}`,
      tags: ['investment-income'],
      meta: { daysAccrued: days, onBalance: balance, reinvested: d.reinvest },
    });

    if (d.reinvest) {
      // Straight back out again. Net-zero, so it changes no totals — but it does stop the
      // cash chart claiming this money is available to spend.
      ctx.emitGroup(`reinvest:${source.id}:${date}`, [
        {
          date, kind: 'transfer', phase: 'POSTTAX_CONTRIBUTION', account: d.account,
          cashAmount: -amount, category: 'investment', probability,
          label: `${source.name} — reinvested`, tags: ['investment', 'transfer'],
        },
        {
          date, kind: 'transfer', phase: 'POSTTAX_CONTRIBUTION', account: holdingAccount,
          cashAmount: amount, category: 'investment', probability,
          label: `${source.name} — reinvested`, tags: ['investment', 'transfer'],
        },
      ]);
    }
  }
}

function describe(source) {
  const d = { ...INVESTMENT_INCOME_DEFAULTS, ...source.details };
  const money = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const rate = `${Math.round(d.yieldRate * 1000) / 10}%`;
  return `${money(d.balance)} at ${rate}, paid ${d.frequency}${d.reinvest ? ', reinvested' : ''}`;
}

export const investmentIncomeType = registerSourceType({
  type: 'investment_income',
  complexity: 'advanced',
  label: 'Investment income',
  family: 'income',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.balance', 'details.yieldRate', 'details.frequency',
    'details.incomeType', 'details.reinvest',
  ],
  defaults: () => ({
    id: '', type: 'investment_income', name: 'New investment income', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...INVESTMENT_INCOME_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});
