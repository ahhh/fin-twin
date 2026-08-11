/**
 * Every view renders without throwing, and emits the accessible markup it should.
 *
 * This is the closest thing to opening the app that runs in CI. It will not catch a layout
 * problem, but it does catch the failures that actually break the page: a renderer
 * throwing on a real model, a table without header cells, an input without a label.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installFakeDom } from './helpers/dom.js';
import { REPO_ROOT } from './helpers/files.js';
import { PACKS } from './helpers/packs.js';
import { sliceModel } from './helpers/models.js';

let dom;
before(() => { dom = installFakeDom(); });
after(() => dom.restore());

// Imported after the DOM exists, since some modules capture nothing but it keeps intent clear.
const { registerBuiltInCloseRules } = await import('../model/close-rules.js');
const { runProjection } = await import('../model/engine.js');
const { resolveSources, makeScenario, makeOverride } = await import('../model/scenarios.js');
const { migrate } = await import('../model/persistence.js');
const { attribute } = await import('../model/attribution.js');
const views = await import('../ui/views.js');
const { renderSpecTable, renderSpecWithTable } = await import('../ui/tables.js');
const { renderKpiRow, renderWarnings, renderTaxSummary, renderAttributionPanel } = await import('../ui/insights.js');
const { renderSourceForm } = await import('../ui/forms.js');
const { buildTimelineSpec, buildCashSpec } = await import('../ui/chartspecs.js');

registerBuiltInCloseRules();

const templates = JSON.parse(await readFile(join(REPO_ROOT, 'data/templates.json'), 'utf8')).templates;
const sampleModel = migrate(templates.find((t) => t.sample).model);

/** The showcase template, forced to advanced — what the fuller UI renders against. */
const advancedModel = {
  ...migrate(templates.find((t) => t.id === 'freelancer-plus-salary').model),
  complexity: 'advanced',
};

/** A store stub with just enough surface for the views. */
function fakeStore(model) {
  const cache = new Map();
  const store = {
    model,
    scenarioId: 'base',
    usingSample: false,
    lastError: null,
    taxPacks: PACKS,
    updates: [],
    run(scenarioId = 'base', mode = 'expected') {
      const key = `${scenarioId}:${mode}`;
      if (!cache.has(key)) {
        cache.set(key, runProjection({ ...store.model, taxPacks: PACKS }, { scenarioId, mode, resolveSources }));
      }
      return cache.get(key);
    },
    runComparison(scenarioId = 'base') {
      const base = store.run(scenarioId, 'expected');
      if (base.uncertainSourceIds.length === 0) return new Map([['Projection', base]]);
      return new Map([
        ['If it lands', store.run(scenarioId, 'won')],
        ['Blended', base],
        ['If it does not', store.run(scenarioId, 'lost')],
      ]);
    },
    update(mutate) {
      const draft = structuredClone(store.model);
      mutate(draft);
      store.model = draft;
      store.updates.push(draft);
      cache.clear();
    },
    setScenario(id) { store.scenarioId = id; cache.clear(); },
  };
  return store;
}

/* -------------------------------------------------------------------------- */

test('every view renders the sample model without throwing', () => {
  const store = fakeStore(sampleModel);

  for (const [name, render] of [
    ['dashboard', () => views.dashboardView(store)],
    ['income', () => views.sourcesView(store, 'income')],
    ['expenses', () => views.sourcesView(store, 'expense')],
    ['taxes', () => views.taxesView(store)],
    ['scenarios', () => views.scenariosView(store)],
    ['assumptions', () => views.assumptionsView(store)],
  ]) {
    let node;
    assert.doesNotThrow(() => { node = render(); }, `${name} view threw`);
    assert.ok(node.children.length > 0, `${name} view rendered nothing`);
  }
});

test('the dashboard shows the three futures when income is uncertain', () => {
  const store = fakeStore(advancedModel);
  const text = views.dashboardView(store).text();

  assert.match(text, /might not happen/i, 'the uncertainty strip should be present');
  assert.match(text, /If it lands/);
  assert.match(text, /If it does not/);
  assert.match(text, /not the same as half of it arriving/i,
    'the point about expected value should be stated, not implied');
});

test('a certain model shows no uncertainty strip', () => {
  const certain = {
    ...advancedModel,
    sources: advancedModel.sources.map((s) => ({ ...s, certainty: { ...s.certainty, mode: 'fixed' } })),
  };
  const text = views.dashboardView(fakeStore(certain)).text();
  assert.doesNotMatch(text, /might not happen/i);
});

test('every chart ships with a data table carrying the same numbers', () => {
  const run = fakeStore(sampleModel).run();

  for (const spec of [buildTimelineSpec(run), buildCashSpec(run)]) {
    const figure = renderSpecWithTable(spec, null);
    const tables = figure.querySelectorAll('table');
    assert.equal(tables.length, 1, `${spec.id} has no data table`);

    const table = tables[0];
    const headers = table.querySelectorAll('th');
    assert.ok(headers.length >= spec.series.length, `${spec.id} table is missing header cells`);

    // One body row per label, plus the header and totals rows.
    const rows = table.querySelectorAll('tr');
    assert.equal(rows.length, spec.labels.length + 2, `${spec.id} table has the wrong number of rows`);

    assert.match(figure.text(), /Estimate/i, `${spec.id} lost its disclaimer`);
  }
});

test('the data table is built from the spec, so it cannot drift from the chart', () => {
  const run = fakeStore(sampleModel).run();
  const spec = buildCashSpec(run);
  const table = renderSpecTable(spec);
  const text = table.text();

  // Spot-check that a real value from the spec appears in the rendered table.
  const first = spec.series[0].values[0];
  const formatted = (first / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  assert.ok(text.includes(formatted), `expected ${formatted} in the table`);
});

test('KPI tiles carry their definitions, not just numbers', () => {
  const run = fakeStore(sampleModel).run();
  const row = renderKpiRow(run);

  const definitions = row.querySelectorAll('details');
  assert.ok(definitions.length >= 5, 'most tiles should explain what they mean');
  assert.match(row.text(), /What this means/);
});

test('the tax summary states the rules used and never conflates the rates', () => {
  const run = fakeStore(sampleModel).run();
  const text = renderTaxSummary(run).text();

  assert.match(text, /US Federal 2026 — verified 2026-08-11/, 'the pack and its date must be shown');
  assert.match(text, /not tax advice/i);
  assert.match(text, /Effective rate/);
  assert.match(text, /next dollar of ordinary income/, 'marginal must be described separately');
  assert.match(text, /not interchangeable/i);
});

test('a blended tax year is labelled rather than presented as the answer', () => {
  const store = fakeStore(advancedModel);
  const text = renderTaxSummary(store.run('base', 'expected')).text();
  assert.match(text, /corresponds to no single outcome/i);
});

test('warnings render with severity in words', () => {
  const run = fakeStore(sampleModel).run();
  const node = renderWarnings(run.warnings);
  assert.ok(node.text().length > 0);

  if (run.warnings.length > 0) {
    assert.match(node.text(), /\((error|warn|info)\)/, 'severity must be readable, not colour-coded only');
  }
});

test('the attribution panel states direction in words as well as by sign', () => {
  const model = { ...sliceModel(), taxPacks: PACKS };
  model.scenarios = [makeScenario({
    id: 'delayed',
    name: 'Later start',
    overrides: [makeOverride('job_second', 'startDate', '2027-01-01', { note: 'Starts three months later' })],
  })];

  const base = runProjection(model, { mode: 'lost', resolveSources });
  const scenario = runProjection(model, { scenarioId: 'delayed', mode: 'lost', resolveSources });
  const panel = renderAttributionPanel(attribute(base, scenario, { metric: 'netWorth' }));

  const text = panel.text();
  assert.match(text, /Why did this change/);
  assert.match(text, /lower|higher/, 'the headline must say which way it moved');
  assert.match(text, /Starts three months later/, 'the cause must be named');
  assert.ok(
    panel.querySelectorAll('.visually-hidden').length > 0,
    'each amount needs a screen-reader word for its direction',
  );
});

/* ---- forms ---- */

test('every form input has a label bound to it', () => {
  const store = fakeStore(sampleModel);
  const source = sampleModel.sources[0];
  const form = renderSourceForm(source, (mutate) => store.update(mutate));

  const inputs = [...form.walk()].filter((n) => ['INPUT', 'SELECT'].includes(n.tagName));
  const labelTargets = new Set(form.querySelectorAll('label').map((l) => l.getAttribute('for')));

  assert.ok(inputs.length > 0);
  for (const input of inputs) {
    const id = input.getAttribute('id');
    assert.ok(id, 'an input has no id to label');
    assert.ok(labelTargets.has(id), `input ${input.getAttribute('name')} has no label`);
  }
});

test('advanced fields are hidden behind a disclosure, not dumped on the page', () => {
  const store = fakeStore(sampleModel);
  const form = renderSourceForm(sampleModel.sources[0], (mutate) => store.update(mutate));
  assert.equal(form.querySelectorAll('details').length, 1, 'advanced options should be collapsed');
  assert.match(form.text(), /Advanced options/);
});

test('editing a field updates the model through the store', () => {
  const store = fakeStore(sampleModel);
  const source = sampleModel.sources.find((s) => s.type === 'salary');
  const form = renderSourceForm(source, (mutate) => store.update(mutate));

  const input = [...form.walk()].find((n) => n.getAttribute('name') === 'details.annualAmount');
  assert.ok(input, 'the salary form has no annual amount field');

  input.value = '75000';
  input.dispatch('change');

  const updated = store.model.sources.find((s) => s.id === source.id);
  assert.equal(updated.details.annualAmount, 75_000_00, 'dollars typed in must be stored as cents');
});

test('a bad value is rejected at the input rather than corrupting the model', () => {
  const store = fakeStore(sampleModel);
  const source = sampleModel.sources.find((s) => s.type === 'salary');
  const form = renderSourceForm(source, (mutate) => store.update(mutate));

  const input = [...form.walk()].find((n) => n.getAttribute('name') === 'details.annualAmount');
  const before = store.model.sources.find((s) => s.id === source.id).details.annualAmount;

  input.value = 'not a number';
  input.dispatch('change');

  assert.ok(input.validationMessage, 'the field should report why it is invalid');
  assert.equal(
    store.model.sources.find((s) => s.id === source.id).details.annualAmount,
    before,
    'the model must be untouched',
  );
});

/* ---- scenarios ---- */

test('the scenarios view explains a preset in plain language', () => {
  const store = fakeStore(sampleModel);
  const node = views.scenariosView(store);

  assert.match(node.text(), /Conservative/);
  assert.match(node.text(), /visible changes you can read, edit or delete/i);
});

test('an incomplete scenario is called out, not quietly compared', () => {
  const model = {
    ...sampleModel,
    scenarios: [makeScenario({
      id: 'broken',
      name: 'Broken',
      overrides: [makeOverride('does_not_exist', 'startDate', '2027-01-01')],
    })],
  };
  const text = views.scenariosView(fakeStore(model)).text();
  assert.match(text, /could not be applied/i);
  assert.match(text, /incomplete/i);
});

test('charts degrade to a notice when Chart.js is absent, and the tables still work', () => {
  // Chart.js is not loaded in this environment, which is exactly the degraded path.
  const store = fakeStore(advancedModel);
  const dashboard = views.dashboardView(store);

  assert.match(dashboard.text(), /Chart\.js did not load/);
  assert.ok(dashboard.querySelectorAll('table').length >= 3,
    'every chart must still deliver its numbers as a table');
});
