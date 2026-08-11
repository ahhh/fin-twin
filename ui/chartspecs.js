/**
 * ChartSpecs: the shape both the chart and its data table are rendered from.
 *
 * This intermediate IS the accessibility design. The `<table>` under each chart is not a
 * second rendering path that can drift out of sync — it is the same object, drawn
 * differently. A test asserts the two agree on every total.
 *
 * A spec also carries its own `disclaimer`, so "estimate" labelling is part of the data
 * rather than a CSS class someone can tidy away.
 */

import { sumCash } from '../model/events.js';
import { moneyAxis, periodLabel } from './format.js';

/**
 * @typedef {Object} ChartSpec
 * @property {string} id
 * @property {string} title
 * @property {string} description   Read aloud before the table; explains what it shows.
 * @property {'line'|'bar'} type
 * @property {boolean} [stacked]
 * @property {string[]} labels      One per row, already formatted for display.
 * @property {string[]} rawLabels   The underlying periods, for keys and tooltips.
 * @property {Array} series         [{key, label, values, kind, dashed, axis}]
 * @property {Array} [markers]      Horizontal reference lines.
 * @property {string} unit
 * @property {string|null} disclaimer
 */

/** Series colours, assigned by role rather than by index, so meaning stays stable. */
export const SERIES_ROLES = Object.freeze({
  income: { colour: '#1f6f5c', label: 'Income' },
  expense: { colour: '#9c2f2f', label: 'Spending' },
  tax: { colour: '#9a6a1f', label: 'Tax' },
  net: { colour: '#31527a', label: 'Net' },
  balance: { colour: '#1f6f5c', label: 'Balance' },
  target: { colour: '#7a6a55', label: 'Target' },
  salary: { colour: '#1f6f5c', label: 'Salary' },
  contract: { colour: '#3f7fa6', label: 'Contract' },
  // The irregular-income categories. Distinct hues rather than shades of one, because the
  // whole reason to stack income by source is to see which band is the unreliable one.
  royalty: { colour: '#6b4f9e', label: 'Royalties' },
  'fixed-contract': { colour: '#2f7f7a', label: 'Rent / fixed contract' },
  windfall: { colour: '#a8562f', label: 'Windfall' },
  'investment-income': { colour: '#4a6ea8', label: 'Investment income' },
  other: { colour: '#6a6f7a', label: 'Other' },
});

const ESTIMATE = 'Estimate, under the assumptions you entered.';
const TAX_ESTIMATE = 'Tax estimate only — not tax advice. Verify with a qualified professional.';

const monthLabels = (run) => run.months.map((m) => periodLabel(m.period));
const monthKeys = (run) => run.months.map((m) => m.period);

/** Cash in, out and net, month by month. */
export function buildTimelineSpec(run) {
  const income = [];
  const expense = [];
  const tax = [];
  const net = [];

  for (const month of run.months) {
    const inflow = sumCash(run.events, (e) => e.period === month.period && e.kind === 'income');
    const outflow = -sumCash(run.events, (e) => e.period === month.period && e.kind === 'expense');
    const taxPaid = -sumCash(
      run.events,
      (e) => e.period === month.period && (e.kind === 'withholding' || e.kind === 'tax_payment' || e.kind === 'tax_refund'),
    );
    income.push(inflow);
    expense.push(-outflow);
    tax.push(-taxPaid);
    net.push(inflow - outflow - taxPaid);
  }

  return Object.freeze({
    id: 'timeline',
    title: 'Money in and out',
    description: 'Income, spending and tax for each month, with the net result.',
    type: 'bar',
    stacked: true,
    labels: monthLabels(run),
    rawLabels: monthKeys(run),
    unit: 'cents',
    series: [
      { key: 'income', label: 'Income', values: income, role: 'income' },
      { key: 'expense', label: 'Spending', values: expense, role: 'expense' },
      { key: 'tax', label: 'Tax', values: tax, role: 'tax' },
      { key: 'net', label: 'Net', values: net, role: 'net', type: 'line' },
    ],
    disclaimer: ESTIMATE,
  });
}

/** Liquid balance over time, with the emergency target and the zero line marked. */
export function buildCashSpec(run) {
  const balance = run.months.map((m) => m.liquid);
  const target = run.metrics?.emergencyTarget?.value ?? 0;

  const markers = [{ key: 'zero', label: 'Zero', value: 0, role: 'expense' }];
  if (target > 0) {
    markers.push({
      key: 'target',
      label: `Emergency target (${run.metrics.emergencyTarget.inputs.targetMonths} months of essentials)`,
      value: target,
      role: 'target',
    });
  }

  return Object.freeze({
    id: 'cash',
    title: 'Liquid cash',
    description:
      'Your cash and savings at the end of each month, against the emergency reserve you ' +
      'are aiming for. Month-end figures can hide a dip part-way through a month — the ' +
      'lowest point is reported separately.',
    type: 'line',
    labels: monthLabels(run),
    rawLabels: monthKeys(run),
    unit: 'cents',
    series: [{ key: 'balance', label: 'Liquid cash', values: balance, role: 'balance' }],
    markers,
    disclaimer: ESTIMATE,
  });
}

/** Where income comes from, stacked, so stability is visible at a glance. */
export function buildIncomeCompositionSpec(run) {
  const bySource = new Map();
  for (const event of run.events) {
    if (event.kind !== 'income') continue;
    if (!bySource.has(event.sourceId)) bySource.set(event.sourceId, new Map());
    const months = bySource.get(event.sourceId);
    months.set(event.period, (months.get(event.period) ?? 0) + event.cashAmount);
  }

  const nameOf = (id) => run.sourcesResolved?.find((s) => s.id === id)?.name ?? id;
  const categoryOf = (id) =>
    run.events.find((e) => e.sourceId === id)?.category ?? 'other';

  const series = [...bySource.entries()]
    .map(([sourceId, months]) => ({
      key: sourceId,
      label: nameOf(sourceId),
      role: SERIES_ROLES[categoryOf(sourceId)] ? categoryOf(sourceId) : 'other',
      values: run.months.map((m) => months.get(m.period) ?? 0),
      total: [...months.values()].reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.total - a.total);

  return Object.freeze({
    id: 'income-composition',
    title: 'Where income comes from',
    description:
      'Each income source stacked by month. A tall single band means the plan leans ' +
      'heavily on one source — worth knowing before it changes, not after.',
    type: 'bar',
    stacked: true,
    labels: monthLabels(run),
    rawLabels: monthKeys(run),
    unit: 'cents',
    series,
    disclaimer: ESTIMATE,
  });
}

/** What tax is made of, and whether it has been paid yet. */
export function buildTaxSpec(run) {
  const years = Object.keys(run.yearResults ?? {}).sort();
  if (years.length === 0) return null;

  const pick = (fn) => years.map((y) => fn(run.yearResults[y]));
  const extrapolated = years.filter((y) => run.yearResults[y].extrapolated);
  const blended = years.some((y) => run.yearResults[y].blendedApproximation);

  return Object.freeze({
    id: 'tax',
    title: 'Estimated tax by year',
    description:
      'What the tax estimate is made of, and how much of it has already been withheld or ' +
      'paid in. Anything left is what you still owe.',
    type: 'bar',
    stacked: true,
    labels: years,
    rawLabels: years,
    unit: 'cents',
    series: [
      { key: 'ordinary', label: 'Income tax', values: pick((r) => r.ordinaryTax), role: 'tax' },
      { key: 'se', label: 'Self-employment tax', values: pick((r) => r.selfEmploymentTax), role: 'contract' },
      { key: 'medicare', label: 'Additional Medicare', values: pick((r) => r.additionalMedicare), role: 'other' },
      { key: 'withheld', label: 'Already withheld', values: pick((r) => -r.withheld), role: 'income' },
      { key: 'estimated', label: 'Estimated payments', values: pick((r) => -r.estimatedPaid), role: 'net' },
    ],
    notes: [
      ...(extrapolated.length > 0
        ? [`${extrapolated.join(', ')} use carried-forward rules, not published figures for those years.`]
        : []),
      ...(blended
        ? ['One or more years blend uncertain income. A blended tax figure corresponds to no single outcome — compare the "if it lands" and "if it does not" runs instead.']
        : []),
    ],
    disclaimer: TAX_ESTIMATE,
  });
}

/** Two or three runs side by side. */
export function buildCompareSpec(runs, { metric = 'liquid' } = {}) {
  const entries = [...runs.entries()];
  const [, first] = entries[0];

  const valueOf = (run, index) => {
    const month = run.months[index];
    if (!month) return null;
    return metric === 'liquid' ? month.liquid : sumOfBalances(month.closing);
  };

  return Object.freeze({
    id: 'compare',
    title: metric === 'liquid' ? 'Liquid cash, compared' : 'Net worth, compared',
    description: 'The same months under each scenario. Series are distinguished by line style as well as colour.',
    type: 'line',
    labels: monthLabels(first),
    rawLabels: monthKeys(first),
    unit: 'cents',
    series: entries.map(([name, run], index) => ({
      key: name,
      label: name,
      // Dash pattern as well as colour: scenario identity must not depend on colour alone.
      dash: [[], [6, 4], [2, 3]][index % 3],
      pointStyle: ['circle', 'rect', 'triangle'][index % 3],
      role: index === 0 ? 'balance' : index === 1 ? 'net' : 'other',
      values: first.months.map((_, i) => valueOf(run, i)),
    })),
    disclaimer: ESTIMATE,
  });
}

function sumOfBalances(balances) {
  return Object.values(balances).reduce((a, b) => a + b, 0);
}

/** Column totals for a spec — used by both the table footer and the drift test. */
export function specTotals(spec) {
  return spec.series.map((s) => ({
    key: s.key,
    label: s.label,
    total: s.values.reduce((sum, v) => sum + (v ?? 0), 0),
  }));
}

export { moneyAxis };
