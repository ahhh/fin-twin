/**
 * A windfall — one lump, once, and quite possibly not at all.
 *
 * The reason this is not just a contract with `frequency: 'once'` is tax. A windfall is
 * the one category of income where "is this taxed?" has genuinely different answers, and
 * where the wrong answer is enormous rather than marginal:
 *
 *   An inheritance is not income to the person receiving it. Neither is a gift, nor the
 *   compensatory part of a personal-injury settlement. A lottery win, a prize and most
 *   other settlements are ordinary income. An employer's bonus is wages, withheld at
 *   source like any other pay.
 *
 * Modelling a $200k inheritance as ordinary income invents a tax bill of roughly $60k
 * that does not exist, and the projection is then wrong in every month after it. So the
 * treatment is a required choice with plain-language options, not a default.
 *
 * The other half of a windfall is that it might not happen, which is what `certainty`
 * already does — hence the default of "possible" rather than "certain". The three runs
 * are the point: a plan that only works if the inheritance arrives is a plan worth
 * seeing without it.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { scaleCents } from '../money.js';
import { INCOME_TAX_WITHHOLDING_TAGS } from './salary.js';

/**
 * How each kind of windfall is taxed. `taxCategory: null` means it is not income at all —
 * the event still moves cash, it just never reaches the return.
 */
export const WINDFALL_TREATMENTS = Object.freeze({
  bonus: { label: 'Bonus from an employer', taxCategory: 'w2_wages', tag: 'bonus' },
  prize: { label: 'Prize or lottery win', taxCategory: 'other_ordinary', tag: 'prize' },
  settlement: { label: 'Legal settlement (taxable)', taxCategory: 'other_ordinary', tag: 'settlement' },
  // Deliberately no "sale of an asset" option: taxing the whole proceeds as a gain would
  // overstate the bill by the cost basis. Selling something you own is `asset.js`, which
  // knows what you paid for it.
  inheritance: { label: 'Inheritance (not taxed)', taxCategory: null, tag: 'inheritance' },
  gift: { label: 'Gift received (not taxed)', taxCategory: null, tag: 'gift' },
  injury: { label: 'Injury settlement (not taxed)', taxCategory: null, tag: 'settlement' },
});

export const WINDFALL_DEFAULTS = Object.freeze({
  amount: 0,
  treatment: 'bonus',
  withholdingRate: 0,
  account: 'cash',
});

const FIELDS = [
  { path: 'name', label: 'What it is', kind: 'text', required: true },
  { path: 'details.amount', label: 'Amount', kind: 'money', required: true, min: 0 },
  { path: 'startDate', label: 'Expected on', kind: 'date', required: true },
  {
    path: 'details.treatment', label: 'What kind of money is it', kind: 'select', required: true,
    options: Object.entries(WINDFALL_TREATMENTS).map(([value, t]) => ({ value, label: t.label })),
    help: 'This decides whether it is taxed at all, which matters more here than anywhere else in the model.',
  },
  {
    path: 'certainty.mode', label: 'How certain is this?', kind: 'select',
    options: [
      { value: 'probability', label: 'Possible, not certain' },
      { value: 'fixed', label: 'Certain' },
    ],
  },
  {
    path: 'certainty.confidence', label: 'Chance it happens', kind: 'percent', min: 0, max: 1,
    help: 'The model shows the plan with it and without it. The one without is usually the interesting one.',
  },
  {
    path: 'details.withholdingRate', label: 'Withheld at source', kind: 'percent', min: 0, max: 1,
    help: 'Bonuses and large prizes are usually withheld before you see the money. Leave at zero if it arrives whole.',
  },
  { path: 'details.account', label: 'Paid into', kind: 'text', advanced: true },
];

function check(source) {
  const warnings = [];
  const d = { ...WINDFALL_DEFAULTS, ...source.details };
  const treatment = WINDFALL_TREATMENTS[d.treatment];

  if (d.amount < 0) {
    warnings.push(makeWarning('source.negative_amount', { name: source.name, field: 'amount' }, source.id));
  }
  if (d.amount === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
  }
  if (!treatment) {
    warnings.push(makeWarning('windfall.unknown_treatment',
      { name: source.name, treatment: d.treatment }, source.id));
    return warnings;
  }

  // Withholding on money that is not income is almost always a mis-entry, and it would
  // otherwise show up as a tax prepayment the user never actually made.
  if (d.withholdingRate > 0 && treatment.taxCategory === null) {
    warnings.push(makeWarning('windfall.withholding_on_untaxed',
      { name: source.name, kind: treatment.label }, source.id));
  }
  if (d.withholdingRate > 0 && !source.personId) {
    warnings.push(makeWarning('windfall.withholding_without_person', { name: source.name }, source.id));
  }
  return warnings;
}

function compile(source, ctx) {
  const d = { ...WINDFALL_DEFAULTS, ...source.details };
  if (d.amount === 0) return;

  const treatment = WINDFALL_TREATMENTS[d.treatment];
  if (!treatment) return;  // `check` has already said so; emitting nothing beats guessing.

  const probability = source.certainty?.mode === 'probability'
    ? (source.certainty.confidence ?? 1)
    : 1;

  const taxable = treatment.taxCategory === null ? 0 : d.amount;

  // One groupId across the lump and its withholding. The tax-reserve close rule reserves
  // against income whose group has no withholding leg, so grouping them is what stops a
  // withheld bonus being reserved for twice.
  const groupId = `windfall:${source.id}:${source.startDate}`;

  ctx.emit({
    date: source.startDate,
    groupId,
    kind: 'income',
    phase: 'INCOME_GROSS',
    account: d.account,
    cashAmount: d.amount,
    taxableAmount: taxable,
    taxCategory: treatment.taxCategory,
    category: 'windfall',
    probability,
    label: source.name,
    tags: [...new Set([treatment.tag, 'variable-income', 'windfall'])].sort(),
    meta: { treatment: d.treatment, taxed: taxable !== 0 },
  });

  // Withholding needs a person — the Social Security wage base is per person, so
  // `events.js` refuses an unattributed withholding leg. Rather than emit an invalid
  // event we skip it and `check` explains why the money arrived whole.
  const withheld = scaleCents(d.amount, d.withholdingRate);
  if (withheld > 0 && source.personId) {
    ctx.emit({
      date: source.startDate,
      groupId,
      kind: 'withholding',
      phase: 'WITHHOLDING',
      account: d.account,
      cashAmount: -withheld,
      category: 'tax',
      probability,
      label: `${source.name} — withheld`,
      tags: [...INCOME_TAX_WITHHOLDING_TAGS],
    });
  }
}

function describe(source) {
  const d = { ...WINDFALL_DEFAULTS, ...source.details };
  const money = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  const odds = source.certainty?.mode === 'probability'
    ? `, ${Math.round((source.certainty.confidence ?? 1) * 100)}% likely`
    : '';
  const kind = WINDFALL_TREATMENTS[d.treatment]?.label ?? d.treatment;
  return `${money(d.amount)} — ${kind.toLowerCase()}${odds}`;
}

export const windfallType = registerSourceType({
  type: 'windfall',
  complexity: 'advanced',
  label: 'Windfall',
  family: 'income',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate',
    'details.amount', 'details.treatment', 'details.withholdingRate',
    'certainty.mode', 'certainty.confidence',
  ],
  defaults: () => ({
    id: '', type: 'windfall', name: 'New windfall', enabled: true, personId: null,
    startDate: '', endDate: null,
    // Possible rather than certain, on purpose. A windfall you are sure of is a rarer
    // thing than one you are hoping for, and the hoped-for one needs the second run.
    certainty: { mode: 'probability', confidence: 0.5, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...WINDFALL_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});
