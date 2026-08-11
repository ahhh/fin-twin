/**
 * Rendering a ChartSpec as an accessible table.
 *
 * Every chart ships with one of these. It is not a fallback — it is the same object the
 * chart draws, so the two cannot disagree, and it is the only representation that works
 * in a screen reader, in a print-out, and when you want to copy a number.
 */

import { byUnit, money } from './format.js';

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
};

/** A `<table>` for the spec, with a totals row. */
export function renderSpecTable(spec) {
  const table = el('table', { className: 'data-table' });

  const caption = el('caption', { text: spec.title });
  table.append(caption);

  const head = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', { scope: 'col', text: 'Month' }));
  for (const series of spec.series) {
    headRow.append(el('th', { scope: 'col', className: 'num', text: series.label }));
  }
  head.append(headRow);
  table.append(head);

  const body = el('tbody');
  spec.labels.forEach((label, index) => {
    const row = el('tr');
    row.append(el('th', { scope: 'row', text: label }));
    for (const series of spec.series) {
      const value = series.values[index];
      const cell = el('td', { className: 'num', text: byUnit(value, spec.unit) });
      if (typeof value === 'number' && value < 0) cell.classList.add('amount-negative');
      row.append(cell);
    }
    body.append(row);
  });
  table.append(body);

  const foot = el('tfoot');
  const footRow = el('tr');
  footRow.append(el('th', { scope: 'row', text: 'Total' }));
  for (const series of spec.series) {
    const total = series.values.reduce((sum, v) => sum + (v ?? 0), 0);
    footRow.append(el('td', { className: 'num', text: byUnit(total, spec.unit) }));
  }
  foot.append(footRow);
  table.append(foot);

  return table;
}

/**
 * A chart with its data table in a `<details>` beneath it.
 *
 * The disclaimer comes from the spec rather than from markup, so it cannot be removed by
 * tidying the CSS.
 */
export function renderSpecWithTable(spec, chartNode) {
  const figure = el('figure', { className: 'chart-figure' });

  figure.append(el('figcaption', { className: 'chart-title', text: spec.title }));
  if (spec.description) {
    figure.append(el('p', { className: 'chart-description', text: spec.description }));
  }
  if (chartNode) figure.append(chartNode);

  for (const note of spec.notes ?? []) {
    figure.append(el('p', { className: 'chart-note', text: note }));
  }
  if (spec.disclaimer) {
    figure.append(el('p', { className: 'chart-disclaimer', text: spec.disclaimer }));
  }

  const details = el('details', { className: 'chart-data' });
  details.append(el('summary', { text: 'Show the numbers' }));
  details.append(el('div', { className: 'scroll-x' }, renderSpecTable(spec)));
  figure.append(details);

  return figure;
}

/** A simple key/value table, for the tax summary and similar. */
export function renderKeyValueTable(rows, { caption = null } = {}) {
  const table = el('table', { className: 'data-table' });
  if (caption) table.append(el('caption', { text: caption }));

  const body = el('tbody');
  for (const row of rows) {
    if (!row) continue;
    const tr = el('tr');
    tr.append(el('th', { scope: 'row', text: row.label }));
    const value = row.unit ? byUnit(row.value, row.unit) : row.text ?? money(row.value);
    const cell = el('td', { className: 'num', text: value });
    if (row.emphasis) cell.classList.add('emphasis');
    tr.append(cell);
    body.append(tr);
  }
  table.append(body);
  return table;
}

export { el };
