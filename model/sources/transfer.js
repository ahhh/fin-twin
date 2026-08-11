/**
 * An explicit transfer between the user's own accounts.
 *
 * Always two legs summing to zero, so net worth is unchanged by construction — moving
 * money changes where it is, not how much of it there is. This is invariant #2, and the
 * reason a transfer is a distinct `kind` rather than an expense with a note.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { expandSchedule } from '../recurrence.js';

export const TRANSFER_DEFAULTS = Object.freeze({
  amount: 0,
  frequency: 'monthly',
  fromAccount: 'cash',
  toAccount: 'savings',
  anchorDay: null,
});

const FIELDS = [
  { path: 'name', label: 'Name', kind: 'text', required: true },
  { path: 'details.amount', label: 'Amount', kind: 'money', required: true, min: 0 },
  {
    path: 'details.frequency', label: 'How often', kind: 'select', required: true,
    options: [
      { value: 'monthly', label: 'Monthly' },
      { value: 'biweekly', label: 'Every two weeks' },
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'annual', label: 'Annually' },
      { value: 'once', label: 'One-off' },
    ],
  },
  { path: 'startDate', label: 'Starts', kind: 'date', required: true },
  { path: 'endDate', label: 'Ends', kind: 'date' },
  { path: 'details.fromAccount', label: 'From', kind: 'text', required: true },
  { path: 'details.toAccount', label: 'To', kind: 'text', required: true },
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
  const d = { ...TRANSFER_DEFAULTS, ...source.details };
  if (d.amount === 0 || d.fromAccount === d.toAccount) return;

  const dates = expandSchedule({
    start: source.startDate,
    end: source.endDate,
    frequency: d.frequency,
    anchorDay: d.anchorDay,
    windowStart: ctx.horizon.startDate,
    windowEnd: ctx.horizon.endDate,
  });

  for (const date of dates) {
    ctx.emitGroup(`xfer:${source.id}:${date}`, [
      {
        date, kind: 'transfer', phase: 'TRANSFER', account: d.fromAccount,
        cashAmount: -d.amount, category: 'transfer',
        label: `${source.name} — out of ${d.fromAccount}`, tags: ['transfer'],
      },
      {
        date, kind: 'transfer', phase: 'TRANSFER', account: d.toAccount,
        cashAmount: d.amount, category: 'transfer',
        label: `${source.name} — into ${d.toAccount}`, tags: ['transfer'],
      },
    ]);
  }
}

export const transferType = registerSourceType({
  type: 'transfer',
  complexity: 'advanced',
  label: 'Transfer between accounts',
  family: 'transfer',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.amount', 'details.frequency', 'details.fromAccount', 'details.toAccount',
  ],
  defaults: () => ({
    id: '', type: 'transfer', name: 'New transfer', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...TRANSFER_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe: (source) => `${(source.details.amount / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} ${source.details.frequency}`,
});
