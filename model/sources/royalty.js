/**
 * Royalty income — a statement, not an invoice.
 *
 * Three things separate a royalty from the contract work next door, and each is a reason
 * the money behaves differently in a bank account:
 *
 *   You do not choose the amount. A contract is a number you agreed to. A royalty is
 *   whatever the statement says, which is why this type is built around a low / base /
 *   high range rather than a single figure. The range is not decoration — `realize()`
 *   runs the whole projection at each end of it, so "what if the book sells badly" is a
 *   full projection with its own tax bill, not a percentage in a footnote.
 *
 *   Statements arrive long after the sales. Quarterly reporting on net-90 terms means
 *   January's sales are cash in roughly July. That lag is the default here, not an
 *   advanced option, because it is the single most common reason a royalty projection
 *   looks fine and the actual account does not.
 *
 *   The tax treatment depends on whose work it is. Royalties on your own creative or
 *   professional work are self-employment income and carry SE tax; royalties you merely
 *   own — inherited, bought, or from a business you no longer work in — are ordinary
 *   income and do not. The difference is about 15% of the money, so it is a question
 *   worth asking rather than assuming.
 *
 * Like `contract.js`, this emits the full base amount and lets `realize()` do the scaling.
 * The compiler never pre-multiplies, or one compiled stream could not serve every run.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { expandSchedule, shiftForLag } from '../recurrence.js';

export const ROYALTY_DEFAULTS = Object.freeze({
  amount: 0,               // the base statement — what you would put in a budget
  lowAmount: null,         // null = no range; the projection runs on `amount` alone
  highAmount: null,
  frequency: 'quarterly',  // how publishers and labels actually report
  statementLagDays: 90,
  selfEmployment: true,
  account: 'cash',
  work: '',
});

const FIELDS = [
  { path: 'name', label: 'Work or catalogue', kind: 'text', required: true },
  {
    path: 'details.amount', label: 'Typical statement', kind: 'money', required: true, min: 0,
    help: 'What a normal statement pays. The low and high figures below vary around this.',
  },
  {
    path: 'details.lowAmount', label: 'A bad statement', kind: 'money', min: 0,
    help: 'Leave blank if you would rather model one figure. Otherwise this is the whole point: the projection is run at this number too.',
  },
  { path: 'details.highAmount', label: 'A good statement', kind: 'money', min: 0 },
  {
    path: 'details.frequency', label: 'Statements arrive', kind: 'select', required: true,
    options: [
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'semiannual', label: 'Twice a year' },
      { value: 'annual', label: 'Annually' },
      { value: 'monthly', label: 'Monthly' },
      { value: 'once', label: 'One-off' },
    ],
  },
  { path: 'startDate', label: 'First statement period', kind: 'date', required: true },
  { path: 'endDate', label: 'Last statement period', kind: 'date', help: 'Leave blank if ongoing.' },
  {
    path: 'details.statementLagDays', label: 'Paid this long after (days)', kind: 'int', min: 0, max: 365,
    help: 'Royalties are reported in arrears. Net-90 on a quarterly statement means sales in January are cash in about July.',
  },
  {
    path: 'details.selfEmployment', label: 'Royalties on your own work', kind: 'bool',
    help: 'Your own writing, music, patents or software: self-employment tax applies. Turn this off for a catalogue you own but did not create.',
  },
  {
    path: 'certainty.mode', label: 'Will they keep coming?', kind: 'select', advanced: true,
    options: [
      { value: 'fixed', label: 'Yes — only the amount varies' },
      { value: 'probability', label: 'They might stop altogether' },
    ],
  },
  {
    path: 'certainty.confidence', label: 'Chance they keep coming', kind: 'percent', min: 0, max: 1, advanced: true,
    help: 'Separate from the range above: that is how big the cheque is, this is whether there is one at all.',
  },
  { path: 'details.account', label: 'Paid into', kind: 'text', advanced: true },
];

function check(source) {
  const warnings = [];
  const d = { ...ROYALTY_DEFAULTS, ...source.details };

  if (d.amount < 0) {
    warnings.push(makeWarning('source.negative_amount', { name: source.name, field: 'typical statement' }, source.id));
  }
  if (d.amount === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
  }
  // A range that does not bracket the base would make the "good" run worse than the
  // ordinary one, which is the sort of thing you only notice three charts later.
  if (d.lowAmount !== null && d.highAmount !== null && d.lowAmount > d.highAmount) {
    warnings.push(makeWarning('royalty.range_inverted', {
      name: source.name, low: d.lowAmount, high: d.highAmount,
    }, source.id));
  }
  if (d.lowAmount !== null && d.lowAmount > d.amount) {
    warnings.push(makeWarning('royalty.base_outside_range', { name: source.name, end: 'low' }, source.id));
  }
  if (d.highAmount !== null && d.highAmount < d.amount) {
    warnings.push(makeWarning('royalty.base_outside_range', { name: source.name, end: 'high' }, source.id));
  }
  return warnings;
}

function compile(source, ctx) {
  const d = { ...ROYALTY_DEFAULTS, ...source.details };
  if (d.amount === 0) return;

  const probability = source.certainty?.mode === 'probability'
    ? (source.certainty.confidence ?? 1)
    : 1;

  // A range only exists if at least one end was given. Missing ends fall back to the base,
  // so "I know it could be bad but not how good" is expressible without inventing a number.
  const hasRange = d.lowAmount !== null || d.highAmount !== null;
  const range = hasRange
    ? { low: d.lowAmount ?? d.amount, base: d.amount, high: d.highAmount ?? d.amount }
    : null;

  // Statement periods run over the WORK window; the horizon is applied to the PAYMENT
  // date, because that is when the cash moves. Same reasoning as contract.js — a Q4
  // statement on net-90 lands outside a horizon ending in December, and `emit` says so.
  const statementDates = expandSchedule({
    start: source.startDate,
    end: source.endDate,
    frequency: d.frequency,
    businessDayRule: 'none',
    windowStart: source.startDate,
    windowEnd: source.endDate ?? ctx.horizon.endDate,
  });

  const taxCategory = d.selfEmployment ? 'se_net_profit' : 'other_ordinary';

  for (const statementDate of statementDates) {
    const paidOn = shiftForLag(statementDate, d.statementLagDays, 'none');

    ctx.emit({
      date: paidOn,
      kind: 'income',
      phase: 'INCOME_GROSS',
      account: d.account,
      cashAmount: d.amount,
      taxableAmount: d.amount,
      taxCategory,
      category: 'royalty',
      probability,
      label: `${source.name} — statement ${statementDate}`,
      // 'variable-income' is what makes metrics.js count this against the share of income
      // that cannot be relied on. Without it a royalty reads as dependable salary.
      tags: ['royalty', 'variable-income'],
      meta: {
        statementDate,
        statementLagDays: d.statementLagDays,
        work: d.work || source.name,
        ...(range ? { range } : {}),
      },
    });
  }
}

function describe(source) {
  const d = { ...ROYALTY_DEFAULTS, ...source.details };
  const money = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const spread = d.lowAmount !== null || d.highAmount !== null
    ? ` (${money(d.lowAmount ?? d.amount)}–${money(d.highAmount ?? d.amount)})`
    : '';
  return `${money(d.amount)}${spread} ${d.frequency}, paid ${d.statementLagDays} days later`;
}

export const royaltyType = registerSourceType({
  type: 'royalty',
  // Advanced: untaxed at source, lagged, and ranged — every reason advanced mode exists.
  complexity: 'advanced',
  label: 'Royalties',
  family: 'income',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.amount', 'details.lowAmount', 'details.highAmount',
    'details.frequency', 'details.statementLagDays', 'details.selfEmployment',
    'certainty.mode', 'certainty.confidence',
  ],
  defaults: () => ({
    id: '', type: 'royalty', name: 'New royalty', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...ROYALTY_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});
