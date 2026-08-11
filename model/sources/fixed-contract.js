/**
 * Fixed contract income — rent, a retainer, a licence fee, an annuity.
 *
 * The amount is agreed and does not vary. What varies is whether it arrives at all, and
 * that is the whole reason this is a separate type rather than a salary with a different
 * label. A tenancy has void periods. A retainer has the month the client paused. An
 * annual escalator raises the figure on the anniversary of the agreement, not in January.
 *
 * GAPS ARE STATED, NOT ESTIMATED. There is no "assume 8% vacancy" here, because an 8%
 * haircut spread evenly across every month is the one shape a void period never has. Two
 * empty months in a row is a cash-flow event you plan around; losing 8% of every month is
 * an accounting adjustment you would not notice. The user names the months, and those
 * months produce nothing.
 *
 * Tax treatment is chosen rather than assumed. Rent, a self-employed retainer and a
 * licence fee on something you merely own are three different lines on a return, and the
 * difference between the first two is self-employment tax on the whole amount.
 *
 * What this deliberately does NOT do is net off the costs of the property. Mortgage
 * interest, repairs and insurance are expenses, and expenses already have a type that
 * handles essentials, sinking funds and cut priority properly. Burying them in here would
 * produce a "net rent" figure that no other part of the app could see inside.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { elapsedMonths, expandSchedule, shiftForLag } from '../recurrence.js';
import { addPeriods, toPeriod } from '../dates.js';

/** A gap list is user text; this stops a typo'd range from spinning. */
const MAX_GAP_MONTHS = 600;

export const FIXED_CONTRACT_DEFAULTS = Object.freeze({
  amount: 0,
  frequency: 'monthly',
  gapMonths: '',
  paymentLagDays: 0,
  growthRate: 0,
  growthMode: 'annual-step',
  taxTreatment: 'rental_net',
  account: 'cash',
  payer: '',
});

const FIELDS = [
  { path: 'name', label: 'Property or agreement', kind: 'text', required: true },
  { path: 'details.amount', label: 'Amount per payment', kind: 'money', required: true, min: 0 },
  {
    path: 'details.frequency', label: 'Paid', kind: 'select', required: true,
    options: [
      { value: 'monthly', label: 'Monthly' },
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'semiannual', label: 'Twice a year' },
      { value: 'annual', label: 'Annually' },
      { value: 'weekly', label: 'Weekly' },
      { value: 'semimonthly', label: 'Twice a month' },
    ],
  },
  { path: 'startDate', label: 'Agreement starts', kind: 'date', required: true },
  { path: 'endDate', label: 'Agreement ends', kind: 'date', help: 'Leave blank if it rolls on.' },
  {
    path: 'details.gapMonths', label: 'Months with no payment', kind: 'text',
    help: 'Voids, breaks, the month between tenants. Write them as 2027-03, or a run as 2027-06..2027-08.',
  },
  {
    path: 'details.taxTreatment', label: 'Taxed as', kind: 'select', required: true,
    options: [
      { value: 'rental_net', label: 'Rent from property' },
      { value: 'se_net_profit', label: 'Self-employed retainer (SE tax applies)' },
      { value: 'other_ordinary', label: 'Other ordinary income' },
    ],
  },
  { path: 'details.growthRate', label: 'Annual increase', kind: 'percent', min: -1, max: 1,
    help: 'Applied on the anniversary of the agreement, not on 1 January.' },
  {
    path: 'details.paymentLagDays', label: 'Paid this long after due (days)', kind: 'int', min: 0, max: 365,
    help: 'Rent due on the 1st and paid on the 5th is a lag of 4.', advanced: true,
  },
  {
    path: 'details.growthMode', label: 'How the increase applies', kind: 'select', advanced: true,
    options: [
      { value: 'annual-step', label: 'All at once on the anniversary' },
      { value: 'monthly-compound', label: 'Spread smoothly through the year' },
      { value: 'none', label: 'No increase' },
    ],
  },
  {
    path: 'certainty.mode', label: 'How certain is the agreement?', kind: 'select', advanced: true,
    options: [
      { value: 'fixed', label: 'Signed and certain' },
      { value: 'probability', label: 'Expected to renew, not guaranteed' },
    ],
  },
  {
    path: 'certainty.confidence', label: 'Chance it holds', kind: 'percent', min: 0, max: 1, advanced: true,
    help: 'Use this for a renewal you are counting on. Named empty months above are the certain gaps; this is the uncertain one.',
  },
  { path: 'details.payer', label: 'Tenant or client', kind: 'text', advanced: true },
  { path: 'details.account', label: 'Paid into', kind: 'text', advanced: true },
];

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Read a gap list into the set of periods it names.
 *
 * Returns the unparseable tokens alongside rather than throwing, so `check` can tell the
 * user exactly which fragment it could not read while the projection still runs on the
 * parts it could. Silently ignoring a mistyped gap would show rent arriving in a month
 * the user had said was empty — the failure mode this whole app exists to avoid.
 *
 * @param {string} text  e.g. '2027-03, 2027-06..2027-08'
 * @returns {{months: Set<string>, unreadable: string[]}}
 */
export function parseGapMonths(text) {
  const months = new Set();
  const unreadable = [];

  for (const chunk of String(text ?? '').split(',')) {
    const token = chunk.trim();
    if (token === '') continue;

    const ends = token.split('..').map((part) => part.trim());
    if (ends.length > 2 || !ends.every((part) => PERIOD_PATTERN.test(part))) {
      unreadable.push(token);
      continue;
    }

    const [from, to = from] = ends;
    if (to < from) {
      unreadable.push(token);
      continue;
    }

    let cursor = from;
    for (let guard = 0; cursor <= to; guard++) {
      if (guard >= MAX_GAP_MONTHS) {
        unreadable.push(token);
        break;
      }
      months.add(cursor);
      cursor = addPeriods(cursor, 1);
    }
  }

  return { months, unreadable };
}

function check(source) {
  const warnings = [];
  const d = { ...FIXED_CONTRACT_DEFAULTS, ...source.details };

  if (d.amount < 0) {
    warnings.push(makeWarning('source.negative_amount', { name: source.name, field: 'amount' }, source.id));
  }
  if (d.amount === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
  }

  const { unreadable } = parseGapMonths(d.gapMonths);
  if (unreadable.length > 0) {
    warnings.push(makeWarning('source.unreadable_gap', {
      name: source.name, tokens: unreadable.join(', '),
    }, source.id));
  }
  return warnings;
}

function compile(source, ctx) {
  const d = { ...FIXED_CONTRACT_DEFAULTS, ...source.details };
  if (d.amount === 0) return;

  const probability = source.certainty?.mode === 'probability'
    ? (source.certainty.confidence ?? 1)
    : 1;

  const { months: gaps } = parseGapMonths(d.gapMonths);

  // Due dates are generated over the AGREEMENT window and the horizon is applied to the
  // payment date, so a December rent paid in January is January's cash.
  const dueDates = expandSchedule({
    start: source.startDate,
    end: source.endDate,
    frequency: d.frequency,
    businessDayRule: 'none',
    windowStart: source.startDate,
    windowEnd: source.endDate ?? ctx.horizon.endDate,
  });

  for (const dueDate of dueDates) {
    // The gap is tested against the month the payment was DUE, not the month it lands.
    // A void in March is March's missing rent whatever the payment terms say.
    if (gaps.has(toPeriod(dueDate))) continue;

    const months = Math.max(0, elapsedMonths(source.startDate, dueDate));
    const amount = ctx.helpers.applyGrowth(d.amount, d.growthRate, months, d.growthMode);
    if (amount === 0) continue;

    ctx.emit({
      date: shiftForLag(dueDate, d.paymentLagDays, 'none'),
      kind: 'income',
      phase: 'INCOME_GROSS',
      account: d.account,
      cashAmount: amount,
      taxableAmount: amount,
      taxCategory: d.taxTreatment,
      category: 'fixed-contract',
      probability,
      label: `${source.name} — due ${dueDate}`,
      tags: ['fixed-contract'],
      meta: { dueDate, paymentLagDays: d.paymentLagDays, payer: d.payer || source.name },
    });
  }
}

function describe(source) {
  const d = { ...FIXED_CONTRACT_DEFAULTS, ...source.details };
  const money = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const { months } = parseGapMonths(d.gapMonths);
  const gaps = months.size > 0
    ? `, ${months.size} month${months.size === 1 ? '' : 's'} empty`
    : '';
  return `${money(d.amount)} ${d.frequency}${gaps}`;
}

export const fixedContractType = registerSourceType({
  type: 'fixed_contract',
  // Advanced: no withholding, and a tax treatment the user has to choose.
  complexity: 'advanced',
  label: 'Rent or fixed contract',
  family: 'income',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.amount', 'details.frequency', 'details.gapMonths', 'details.paymentLagDays',
    'details.growthRate', 'details.growthMode', 'details.taxTreatment',
    'certainty.mode', 'certainty.confidence',
  ],
  defaults: () => ({
    id: '', type: 'fixed_contract', name: 'New agreement', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...FIXED_CONTRACT_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});
