/**
 * An asset you might contribute to, and might sell.
 *
 * The sale is the interesting part, because it is where capital gains come from:
 *
 *   proceeds − basis = gain, taxed as short- or long-term depending on how long it was held
 *
 * Note what this deliberately does NOT do: sell "enough to cover the tax bill". That would
 * make the sale depend on the tax, which depends on the sale — a fixed point the engine can
 * iterate but a user cannot reason about. A sale here is a stated decision with a stated
 * amount, so the compiler stays a pure function of one source.
 *
 * Costs of sale are subtracted from proceeds before the gain, which is how they actually
 * work — an agent's commission reduces the gain, it is not a separate deduction.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { expandSchedule } from '../recurrence.js';
import { scaleCents } from '../money.js';
import { daysBetween, isWithin } from '../dates.js';

/** A gain is long-term after more than one year. */
const LONG_TERM_DAYS = 365;

export const ASSET_DEFAULTS = Object.freeze({
  account: '',            // defaults to the source id
  fromAccount: 'cash',
  contribution: 0,
  contributionFrequency: 'monthly',
  costBasis: null,        // null = the opening balance is also the basis
  sale: null,             // {date, proceeds, costsOfSale, acquiredDate}
});

const FIELDS = [
  { path: 'name', label: 'What it is', kind: 'text', required: true },
  { path: 'startDate', label: 'From', kind: 'date', required: true },
  { path: 'endDate', label: 'Until', kind: 'date' },
  { path: 'details.contribution', label: 'Added each period', kind: 'money', min: 0 },
  {
    path: 'details.contributionFrequency', label: 'How often', kind: 'select',
    options: [
      { value: 'monthly', label: 'Monthly' },
      { value: 'quarterly', label: 'Quarterly' },
      { value: 'annual', label: 'Annually' },
      { value: 'once', label: 'One-off' },
    ],
  },
  { path: 'details.costBasis', label: 'What you paid for it', kind: 'money', min: 0, advanced: true,
    help: 'Used to work out the gain if you sell. Defaults to the opening value.' },
  { path: 'details.sale.date', label: 'Sell on', kind: 'date',
    help: 'Leave blank if you are not planning to sell.' },
  { path: 'details.sale.proceeds', label: 'Sale price', kind: 'money', min: 0 },
  { path: 'details.sale.costsOfSale', label: 'Costs of selling', kind: 'money', min: 0, advanced: true,
    help: 'Commission and fees. These reduce the gain rather than being deducted separately.' },
  { path: 'details.sale.acquiredDate', label: 'Bought on', kind: 'date', advanced: true,
    help: 'Decides whether the gain is short- or long-term. Held over a year is long-term.' },
  { path: 'details.account', label: 'Account', kind: 'text', advanced: true },
  { path: 'details.fromAccount', label: 'Contributions from', kind: 'text', advanced: true },
];

function check(source) {
  const warnings = [];
  const d = { ...ASSET_DEFAULTS, ...source.details };
  const sale = d.sale;

  if (sale?.date && !sale.proceeds) {
    warnings.push(makeWarning('asset.sale_without_proceeds', { name: source.name }, source.id));
  }
  if (sale?.date && sale.proceeds && d.costBasis === null) {
    warnings.push(makeWarning('asset.no_cost_basis', { name: source.name }, source.id));
  }
  return warnings;
}

function compile(source, ctx) {
  const d = { ...ASSET_DEFAULTS, ...source.details };
  const account = d.account || source.id;

  /* contributions */
  if (d.contribution > 0) {
    const dates = expandSchedule({
      start: source.startDate,
      end: d.sale?.date ?? source.endDate,
      frequency: d.contributionFrequency,
      windowStart: ctx.horizon.startDate,
      windowEnd: ctx.horizon.endDate,
    });

    for (const date of dates) {
      ctx.emitGroup(`asset:${source.id}:${date}`, [
        {
          date, kind: 'transfer', phase: 'POSTTAX_CONTRIBUTION', account: d.fromAccount,
          cashAmount: -d.contribution, category: 'investment',
          label: `${source.name} — contribution`, tags: ['investment', 'transfer'],
        },
        {
          date, kind: 'transfer', phase: 'POSTTAX_CONTRIBUTION', account,
          cashAmount: d.contribution, category: 'investment',
          label: `${source.name} — invested`, tags: ['investment', 'transfer'],
        },
      ]);
    }
  }

  /* the sale */
  const sale = d.sale;
  if (!sale?.date || !sale.proceeds) return;
  if (!isWithin(sale.date, ctx.horizon.startDate, ctx.horizon.endDate)) return;

  const costs = sale.costsOfSale ?? 0;
  const netProceeds = sale.proceeds - costs;
  const basis = d.costBasis ?? 0;
  const gain = netProceeds - basis;

  const heldDays = sale.acquiredDate ? daysBetween(sale.acquiredDate, sale.date) : LONG_TERM_DAYS + 1;
  const longTerm = heldDays > LONG_TERM_DAYS;

  const groupId = `sale:${source.id}:${sale.date}`;

  // The asset leaves the balance sheet at its carrying value, and the cash arrives. The
  // difference between them is the gain, which is taxable but is NOT a separate cash flow.
  ctx.emit({
    date: sale.date, groupId, kind: 'transfer', phase: 'TRANSFER', account,
    cashAmount: -basis, category: 'investment',
    label: `${source.name} — sold`, tags: ['sale', 'transfer'], seq: 0,
  });
  ctx.emit({
    date: sale.date, groupId, kind: 'transfer', phase: 'TRANSFER', account: d.fromAccount,
    cashAmount: basis, category: 'investment',
    label: `${source.name} — proceeds (return of what you paid)`, tags: ['sale', 'transfer'], seq: 1,
  });

  if (gain !== 0) {
    // The gain is real money arriving AND taxable income, on the same event.
    ctx.emit({
      date: sale.date, groupId, kind: 'income', phase: 'INCOME_GROSS', account: d.fromAccount,
      cashAmount: gain,
      taxableAmount: gain,
      taxCategory: longTerm ? 'long_term_gains' : 'short_term_gains',
      category: 'capital-gains',
      label: `${source.name} — ${longTerm ? 'long-term' : 'short-term'} gain`,
      tags: ['capital-gains', longTerm ? 'long-term' : 'short-term'],
      seq: 2,
      meta: { proceeds: sale.proceeds, costsOfSale: costs, basis, heldDays },
    });
  }
}

function describe(source) {
  const d = { ...ASSET_DEFAULTS, ...source.details };
  const money = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  if (d.sale?.date) return `sold ${d.sale.date} for ${money(d.sale.proceeds ?? 0)}`;
  if (d.contribution > 0) return `${money(d.contribution)} ${d.contributionFrequency}`;
  return 'held';
}

export const assetType = registerSourceType({
  type: 'asset',
  complexity: 'advanced',
  label: 'Investment or property',
  family: 'asset',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.contribution', 'details.contributionFrequency', 'details.costBasis',
    'details.sale.date', 'details.sale.proceeds', 'details.sale.costsOfSale',
  ],
  defaults: () => ({
    id: '', type: 'asset', name: 'New investment', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...ASSET_DEFAULTS, sale: { date: null, proceeds: 0, costsOfSale: 0, acquiredDate: null } },
    notes: '',
  }),
  compile,
  check,
  describe,
});
