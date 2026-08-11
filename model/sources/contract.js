/**
 * Contract / self-employment income.
 *
 * Two things distinguish this from a salary, and both are the point of the whole app:
 *
 *   Payment lag. Work performed in March on net-45 terms is MAY cash. Booking it as March
 *   cash is the most common reason a freelance projection looks comfortable while the
 *   actual bank balance does not.
 *
 *   Uncertainty. A contract carries a probability, and `realize()` later turns that into
 *   a won / expected / lost run. Note that this compiler emits the FULL amount with a
 *   probability attached — it never pre-multiplies. Scaling is a realisation concern, so
 *   that the same compiled stream can produce all three runs.
 *
 * No withholding: 1099 income is not withheld at source. That is exactly why the
 * tax-reserve rule exists.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { elapsedMonths, expandSchedule, shiftForLag } from '../recurrence.js';

export const CONTRACT_DEFAULTS = Object.freeze({
  amount: 0,
  frequency: 'monthly',
  paymentLagDays: 30,
  growthRate: 0,
  growthMode: 'none',
  account: 'cash',
  businessDayRule: 'none',
  client: '',
});

const FIELDS = [
  { path: 'name', label: 'Project or client', kind: 'text', required: true },
  { path: 'details.amount', label: 'Amount per invoice', kind: 'money', required: true, min: 0 },
  {
    path: 'details.frequency', label: 'Billed', kind: 'select', required: true,
    options: [
      { value: 'monthly', label: 'Monthly' },
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'once', label: 'One-off' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'biweekly', label: 'Every two weeks' },
      { value: 'annual', label: 'Annually' },
    ],
  },
  { path: 'startDate', label: 'Work starts', kind: 'date', required: true },
  { path: 'endDate', label: 'Work ends', kind: 'date' },
  {
    path: 'details.paymentLagDays', label: 'Payment terms (days)', kind: 'int', min: 0, max: 365,
    help: 'Net-30, net-45… the gap between invoicing and the money arriving.',
  },
  {
    path: 'certainty.mode', label: 'How certain is this?', kind: 'select',
    options: [
      { value: 'fixed', label: 'Signed and certain' },
      { value: 'probability', label: 'Likely but not certain' },
    ],
  },
  {
    path: 'certainty.confidence', label: 'Chance it happens', kind: 'percent', min: 0, max: 1,
    help: 'The model shows what happens if it lands and if it does not — not just the average.',
  },
  { path: 'details.growthRate', label: 'Rate change per year', kind: 'percent', min: -1, max: 1, advanced: true },
  { path: 'details.account', label: 'Paid into', kind: 'text', advanced: true },
];

function check(source) {
  const warnings = [];
  if (source.details.amount < 0) {
    warnings.push(makeWarning('source.negative_amount', { name: source.name, field: 'amount' }, source.id));
  }
  if (source.details.amount === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
  }
  return warnings;
}

function compile(source, ctx) {
  const d = { ...CONTRACT_DEFAULTS, ...source.details };
  if (d.amount === 0) return;

  const probability = source.certainty?.mode === 'probability'
    ? (source.certainty.confidence ?? 1)
    : 1;

  // Invoices are generated over the WORK window; the horizon window is applied to the
  // PAYMENT date, because that is when the cash actually moves. A December invoice on
  // net-60 terms lands outside a horizon ending in December, and `emit` will say so.
  const invoiceDates = expandSchedule({
    start: source.startDate,
    end: source.endDate,
    frequency: d.frequency,
    businessDayRule: 'none',
    windowStart: source.startDate,
    windowEnd: source.endDate ?? ctx.horizon.endDate,
  });

  for (const invoiceDate of invoiceDates) {
    const months = Math.max(0, elapsedMonths(source.startDate, invoiceDate));
    const amount = ctx.helpers.applyGrowth(d.amount, d.growthRate, months, d.growthMode);
    if (amount === 0) continue;

    const paidOn = shiftForLag(invoiceDate, d.paymentLagDays, d.businessDayRule);

    ctx.emit({
      date: paidOn,
      kind: 'income',
      phase: 'INCOME_GROSS',
      account: d.account,
      cashAmount: amount,
      taxableAmount: amount,
      taxCategory: 'se_net_profit',
      category: 'contract',
      probability,
      label: `${source.name} — invoice ${invoiceDate}`,
      tags: ['self-employed', 'variable-income'],
      meta: { invoiceDate, paymentLagDays: d.paymentLagDays, client: d.client || source.name },
    });
  }
}

function describe(source) {
  const d = { ...CONTRACT_DEFAULTS, ...source.details };
  const dollars = (d.amount / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const odds = source.certainty?.mode === 'probability'
    ? `, ${Math.round((source.certainty.confidence ?? 1) * 100)}% likely`
    : '';
  return `${dollars} ${d.frequency}, net-${d.paymentLagDays}${odds}`;
}

export const contractType = registerSourceType({
  type: 'contract',
  // Advanced: brings untaxed income, payment lag and uncertainty with it.
  complexity: 'advanced',
  label: 'Contract / self-employment',
  family: 'income',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.amount', 'details.frequency', 'details.paymentLagDays', 'details.growthRate',
    'certainty.mode', 'certainty.confidence',
  ],
  defaults: () => ({
    id: '', type: 'contract', name: 'New contract', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...CONTRACT_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});
