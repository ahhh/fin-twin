/**
 * KPI tiles, warnings, and the attribution narrative.
 *
 * Two rules run through this module:
 *   - a figure always travels with its definition, because several of these have more than
 *     one defensible meaning;
 *   - direction is stated in words as well as by sign and colour.
 */

import { byUnit, humanise, money, percent, periodLabel, plural, signedMoney } from './format.js';
import { el } from './tables.js';
import { renderAttribution } from '../model/attribution.js';
import { countBySeverity, sortWarnings } from '../model/warnings.js';
import { kpiAllowed } from '../model/complexity.js';

/** One KPI tile. The definition is rendered, not hidden in a tooltip. */
export function renderKpi({ label, metric, hint = null, tone = null }) {
  const tile = el('div', { className: `kpi${tone ? ` kpi-${tone}` : ''}` });
  tile.append(el('div', { className: 'kpi-label', text: label }));
  tile.append(el('div', { className: 'kpi-value', text: byUnit(metric.value, metric.unit) }));

  if (hint) tile.append(el('div', { className: 'kpi-hint', text: hint }));
  if (metric.definition) {
    const note = el('details', { className: 'kpi-definition' });
    note.append(el('summary', { text: 'What this means' }));
    note.append(el('p', { text: metric.definition }));
    tile.append(note);
  }
  return tile;
}

/**
 * The summary row.
 *
 * Which tiles appear depends on the model's complexity level. Four is about as many
 * numbers as anyone reads at once; the two that simple mode hides — spendable-after-tax
 * and income concentration — mean nothing without untaxed or multiple income sources.
 *
 * @param {Object} run
 * @param {Object} [model]  when omitted, every tile is shown
 */
export function renderKpiRow(run, model = { complexity: 'advanced' }) {
  const m = run.metrics;
  const row = el('div', { className: 'kpi-row' });
  const show = (kpi) => kpiAllowed(model, kpi);

  const shortfall = m.firstShortfall.value;
  const min = m.minimumCash;

  if (show('liquidCash')) {
    row.append(renderKpi({ label: 'Liquid cash at the end', metric: m.liquidCash }));
  }

  if (show('spendableCash')) {
    row.append(renderKpi({
      label: 'Spendable now',
      metric: m.spendableCash,
      hint: m.taxReserveGap.value > 0
        ? `${money(m.taxReserveGap.value)} of tax is not set aside`
        : 'All projected tax is covered',
      tone: m.spendableCash.value < 0 ? 'bad' : null,
    }));
  }

  if (show('minimumCash')) {
    row.append(renderKpi({
      label: 'Lowest cash gets',
      metric: min,
      hint: min.inputs.period
        ? `${periodLabel(min.inputs.period)}${min.inputs.cause ? ` — ${min.inputs.cause}` : ''}`
        : null,
      tone: min.value < 0 ? 'bad' : null,
    }));
  }

  if (show('emergencyMonths')) {
    row.append(renderKpi({
      label: 'Emergency reserve',
      metric: m.emergencyMonths,
      hint: shortfall
        ? `Falls below target in ${periodLabel(shortfall)}`
        : 'Stays above target throughout',
      tone: shortfall ? 'warn' : 'good',
    }));
  }

  // Simple mode replaces the two advanced tiles with the one question a straightforward
  // plan actually turns on: is more coming in than going out?
  if (show('monthlySurplus') && !show('variableIncomeShare')) {
    const surplus = monthlySurplus(run);
    row.append(renderKpi({
      label: 'Left over each month',
      metric: surplus,
      hint: surplus.value < 0 ? 'You are spending more than you earn' : 'On average across the projection',
      tone: surplus.value < 0 ? 'bad' : 'good',
    }));
  }

  if (show('variableIncomeShare')) {
    row.append(renderKpi({
      label: 'Variable income',
      metric: m.variableIncomeShare,
      hint: 'A higher share is a reason to hold a larger reserve, not a problem in itself',
    }));
  }

  if (show('incomeConcentration')) {
    row.append(renderKpi({
      label: 'Largest income source',
      metric: m.incomeConcentration,
      hint: m.incomeConcentration.inputs.sourceName
        ? `${m.incomeConcentration.inputs.sourceName}`
        : null,
    }));
  }

  return row;
}

/** Average monthly change in liquid cash — the headline figure for a simple plan. */
function monthlySurplus(run) {
  const months = run.months.length || 1;
  const opening = run.months[0]?.liquid ?? 0;
  const closing = run.months[months - 1]?.liquid ?? 0;
  return {
    value: Math.round((closing - opening) / months),
    unit: 'cents',
    definition: 'How much your cash and savings change in an average month across the projection, after everything is paid.',
    inputs: { opening, closing, months },
  };
}

/** The warnings panel, worst first. */
export function renderWarnings(warnings) {
  const panel = el('section', { className: 'panel', 'aria-labelledby': 'warnings-heading' });
  panel.append(el('h3', { id: 'warnings-heading', text: 'Things worth checking' }));

  if (warnings.length === 0) {
    panel.append(el('p', { className: 'muted', text: 'Nothing looks inconsistent in this model.' }));
    return panel;
  }

  const counts = countBySeverity(warnings);
  panel.append(el('p', {
    className: 'muted',
    text: [
      counts.error ? plural(counts.error, 'problem') : null,
      counts.warn ? plural(counts.warn, 'warning') : null,
      counts.info ? `${counts.info} note${counts.info === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(', '),
  }));

  const list = el('ul', { className: 'warning-list' });
  for (const warning of sortWarnings(warnings)) {
    const item = el('li', { className: `warning warning-${warning.severity}` });
    item.append(el('strong', { text: warning.title }));
    item.append(el('span', { className: 'warning-severity', text: ` (${warning.severity})` }));
    item.append(el('p', { text: warning.message }));
    list.append(item);
  }
  panel.append(list);
  return panel;
}

/**
 * The attribution narrative.
 *
 * Each line carries an explicit word for direction alongside the sign, so the meaning
 * survives a screen reader and a black-and-white print-out.
 */
export function renderAttributionPanel(report) {
  const { headline, lines, notes } = renderAttribution(report);

  const panel = el('section', { className: 'panel panel-attribution' });
  panel.append(el('h3', { text: 'Why did this change?' }));
  panel.append(el('p', { className: 'attribution-headline', text: headline }));

  if (lines.length === 0) {
    panel.append(el('p', { className: 'muted', text: 'Nothing differs between these two.' }));
    return panel;
  }

  const list = el('ul', { className: 'attribution-list' });
  for (const line of lines) {
    const item = el('li', { className: `attribution-line attribution-${line.classification}` });

    const amount = el('span', {
      className: `attribution-amount ${line.amount < 0 ? 'amount-negative' : 'amount-positive'}`,
      text: line.amountText,
    });
    // The arrow and the visually-hidden word both carry direction, so colour never has to.
    amount.append(el('span', {
      className: 'visually-hidden',
      text: line.amount < 0 ? ' lower' : ' higher',
    }));

    item.append(amount);
    item.append(el('span', { className: 'attribution-label', text: line.label }));
    if (line.reason) item.append(el('span', { className: 'attribution-reason', text: line.reason }));
    list.append(item);
  }
  panel.append(list);

  for (const note of notes) {
    panel.append(el('p', { className: 'notice notice-warn', text: note }));
  }
  return panel;
}

/** The tax summary: liability, what has been paid, what is left. */
export function renderTaxSummary(run) {
  const years = Object.keys(run.yearResults ?? {}).sort();
  const panel = el('section', { className: 'panel' });
  panel.append(el('h3', { text: 'Estimated tax' }));

  if (years.length === 0) {
    panel.append(el('p', {
      className: 'muted',
      text: 'No tax rules are loaded, so tax is not being estimated.',
    }));
    return panel;
  }

  for (const year of years) {
    const r = run.yearResults[year];
    const block = el('div', { className: 'tax-year' });

    block.append(el('h4', { text: `Tax year ${year}` }));
    if (r.extrapolated) {
      block.append(el('p', {
        className: 'notice notice-warn',
        text: `There are no published rules for ${year} yet, so ${r.taxYear} rules were carried forward. Treat these figures as indicative.`,
      }));
    }
    if (r.blendedApproximation) {
      block.append(el('p', {
        className: 'notice notice-warn',
        text: 'This year blends uncertain income. Tax does not average — a blended figure ' +
          'corresponds to no single outcome. Compare "if it lands" against "if it does not" instead.',
      }));
    }

    const rows = [
      { label: 'Gross income', value: r.grossIncome, unit: 'cents' },
      { label: 'Adjusted gross income', value: r.agi, unit: 'cents' },
      { label: r.usedItemized ? 'Itemised deduction' : 'Standard deduction', value: -r.deduction, unit: 'cents' },
      { label: 'Taxable income', value: r.taxableIncome, unit: 'cents' },
      { label: 'Income tax', value: r.ordinaryTax, unit: 'cents' },
      r.selfEmploymentTax ? { label: 'Self-employment tax', value: r.selfEmploymentTax, unit: 'cents' } : null,
      r.additionalMedicare ? { label: 'Additional Medicare', value: r.additionalMedicare, unit: 'cents' } : null,
      { label: 'Total estimated tax', value: r.totalLiability, unit: 'cents', emphasis: true },
      { label: 'Already withheld', value: -r.withheld, unit: 'cents' },
      { label: 'Estimated payments', value: -r.estimatedPaid, unit: 'cents' },
      r.balanceDue
        ? { label: `Due on ${r.trueUp.date}`, value: r.balanceDue, unit: 'cents', emphasis: true }
        : { label: `Refund expected ${r.trueUp.date}`, value: r.refund, unit: 'cents', emphasis: true },
    ];

    const table = el('table', { className: 'data-table' });
    const body = el('tbody');
    for (const row of rows.filter(Boolean)) {
      const tr = el('tr');
      tr.append(el('th', { scope: 'row', text: row.label }));
      const cell = el('td', { className: 'num', text: byUnit(row.value, row.unit) });
      if (row.emphasis) cell.classList.add('emphasis');
      if (row.value < 0) cell.classList.add('amount-negative');
      tr.append(cell);
      body.append(tr);
    }
    table.append(body);
    block.append(el('div', { className: 'scroll-x' }, table));

    block.append(el('p', {
      className: 'muted',
      text: `Effective rate ${percent(r.effectiveOnGross)} of gross income. ` +
        `The next dollar of ordinary income would be taxed at ${percent(r.marginalOrdinary)} — ` +
        'a different figure, and not interchangeable with the effective rate.',
    }));
    block.append(el('p', { className: 'chart-disclaimer', text: `Rules: ${r.packLabel}. Estimate only — not tax advice.` }));

    panel.append(block);
  }

  return panel;
}

/** The next handful of dated events, so the timeline is not the only way to see them. */
export function renderUpcoming(run, { limit = 8 } = {}) {
  const panel = el('section', { className: 'panel' });
  panel.append(el('h3', { text: 'Coming up' }));

  const notable = run.events
    .filter((e) => e.kind !== 'transfer' && Math.abs(e.cashAmount) >= 50_000)
    .slice(0, limit);

  if (notable.length === 0) {
    panel.append(el('p', { className: 'muted', text: 'Nothing large in the near term.' }));
    return panel;
  }

  const list = el('ul', { className: 'upcoming-list' });
  for (const event of notable) {
    const { text, className } = signedMoney(event.cashAmount);
    const item = el('li');
    item.append(el('span', { className: 'upcoming-date', text: event.date }));
    item.append(el('span', { className: 'upcoming-label', text: event.label || humanise(event.category) }));
    item.append(el('span', { className: `upcoming-amount ${className}`, text }));
    list.append(item);
  }
  panel.append(list);
  return panel;
}
