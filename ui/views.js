/**
 * The views. Each returns a DOM node for the main panel; `app.js` decides which to show.
 *
 * Every chart is rendered through `renderSpecWithTable`, so the numbers are always
 * available as a table as well as a picture.
 */

import { sourceTypesByFamily, getSourceType } from '../model/sources/registry.js';
import { attribute } from '../model/attribution.js';
import { PRESETS, buildPresetScenario } from '../model/presets.js';
import { isIncomplete, makeScenario } from '../model/scenarios.js';
import {
  buildCashSpec, buildCompareSpec, buildIncomeCompositionSpec, buildTaxSpec, buildTimelineSpec,
} from './chartspecs.js';
import { renderChart } from './charts.js';
import { renderSpecWithTable, el } from './tables.js';
import {
  renderAttributionPanel, renderKpiRow, renderTaxSummary, renderUpcoming, renderWarnings,
} from './insights.js';
import { newSourceOfType, renderSourceForm, renderTypePicker } from './forms.js';
import { money, periodLabel, plural } from './format.js';
import { advancedPrompts, isAdvanced, panelAllowed, unsupportedInSimple } from '../model/complexity.js';
import { complexityOf } from '../model/sources/registry.js';

const chartFor = (spec) => (spec ? renderSpecWithTable(spec, renderChart(spec)) : null);

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

export function dashboardView(store) {
  const model = store.model;
  const run = store.run(store.scenarioId ?? 'base', 'expected');
  const root = el('div', { className: 'view view-dashboard' });

  // Anything the current level cannot show is announced, never silently dropped.
  const hidden = unsupportedInSimple(model, complexityOf);
  if (hidden.length > 0) root.append(renderHiddenNotice(store, hidden));

  root.append(renderKpiRow(run, model));

  // For an uncertain model, the three futures are the headline, not a footnote.
  if (panelAllowed(model, 'uncertaintyStrip') && run.uncertainSourceIds.length > 0) {
    root.append(renderUncertaintyStrip(store));
  }

  root.append(chartFor(buildCashSpec(run)));
  root.append(chartFor(buildTimelineSpec(run)));
  if (panelAllowed(model, 'incomeComposition')) {
    root.append(chartFor(buildIncomeCompositionSpec(run)));
  }

  const columns = el('div', { className: 'columns' });
  columns.append(renderUpcoming(run));
  columns.append(renderWarnings(run.warnings));
  root.append(columns);

  // Offer the next step only where this particular plan has outgrown the current one.
  const prompts = advancedPrompts(model, run);
  if (prompts.length > 0) root.append(renderAdvancedPrompt(store, prompts));

  return root;
}

/**
 * The nudge toward advanced mode.
 *
 * Deliberately driven by what the user has actually built, so it appears when it is useful
 * rather than sitting there as a permanent advert for features they do not want.
 */
function renderAdvancedPrompt(store, prompts) {
  const panel = el('section', { className: 'panel panel-prompt' });
  panel.append(el('h3', { text: 'There is more this can show you' }));

  const list = el('ul');
  for (const prompt of prompts) list.append(el('li', { text: prompt.message }));
  panel.append(list);

  const button = el('button', { type: 'button', className: 'type-button', text: 'Turn on advanced features' });
  button.addEventListener('click', () => store.setComplexity('advanced'));
  panel.append(button);

  panel.append(el('p', {
    className: 'muted',
    text: 'Nothing in your plan changes — it just stops being hidden. You can switch back.',
  }));
  return panel;
}

/** Something in the model needs advanced mode to be visible at all. */
function renderHiddenNotice(store, hiddenTypes) {
  const notice = el('div', { className: 'notice notice-warn', role: 'status' });
  const labels = hiddenTypes.map((type) => {
    try {
      return getSourceType(type).label.toLowerCase();
    } catch {
      return type;
    }
  });

  notice.append(el('strong', { text: 'Part of this plan is not on screen. ' }));
  notice.append(el('span', {
    text: `It contains ${labels.join(' and ')}, which simple mode does not show. ` +
      'The figures still include them.',
  }));

  const button = el('button', { type: 'button', text: 'Show everything' });
  button.addEventListener('click', () => store.setComplexity('advanced'));
  notice.append(button);
  return notice;
}

/**
 * "If it lands / blended / if it does not".
 *
 * A 50% chance of $35,000 is not the same liquidity experience as $17,500, so the blended
 * run is never shown on its own.
 */
function renderUncertaintyStrip(store) {
  const runs = store.runComparison(store.scenarioId ?? 'base');
  const panel = el('section', { className: 'panel panel-uncertainty' });

  panel.append(el('h3', { text: 'This plan depends on things that might not happen' }));
  panel.append(el('p', {
    className: 'muted',
    text: 'A 50% chance of a payment is not the same as half of it arriving. These are the ' +
      'outcomes, not an average of them.',
  }));

  const strip = el('div', { className: 'strip' });
  for (const [label, run] of runs) {
    const card = el('div', { className: 'strip-card' });
    card.append(el('div', { className: 'strip-label', text: label }));
    card.append(el('div', { className: 'strip-value', text: money(run.metrics.liquidCash.value) }));
    card.append(el('div', {
      className: 'strip-hint',
      text: run.metrics.minimumCash.value < 0
        ? `Dips to ${money(run.metrics.minimumCash.value)} in ${periodLabel(run.metrics.minimumCash.inputs.period)}`
        : `Lowest ${money(run.metrics.minimumCash.value)}`,
    }));
    strip.append(card);
  }
  panel.append(strip);

  const compare = buildCompareSpec(runs, { metric: 'liquid' });
  panel.append(chartFor(compare));
  return panel;
}

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

export function sourcesView(store, family) {
  const root = el('div', { className: 'view view-sources' });
  const model = store.model;

  const relevant = model.sources.filter((s) => {
    try {
      return getSourceType(s.type).family === family;
    } catch {
      return false;
    }
  });

  root.append(el('h2', { text: family === 'income' ? 'Income' : 'Spending' }));

  const addBar = el('div', { className: 'panel' });
  addBar.append(el('h3', { text: 'Add something' }));
  const families = new Map(
    [...sourceTypesByFamily({ complexity: isAdvanced(model) ? 'advanced' : 'simple' })]
      .filter(([key]) => key === family || (family === 'expense' && key === 'transfer')),
  );
  addBar.append(renderTypePicker(families, (type) => {
    store.update((draft) => {
      draft.sources.push(newSourceOfType(type, {
        startDate: draft.horizon?.startDate ?? '2026-01-01',
        personId: draft.household.people[0]?.id ?? null,
      }));
    });
  }));
  root.append(addBar);

  if (relevant.length === 0) {
    root.append(el('p', { className: 'muted', text: 'Nothing here yet.' }));
    return root;
  }

  for (const source of relevant) {
    const card = el('section', { className: `panel source-card${source.enabled ? '' : ' disabled'}` });

    const header = el('div', { className: 'source-header' });
    header.append(el('h3', { text: source.name }));
    header.append(el('span', { className: 'muted', text: getSourceType(source.type).describe(source) }));

    const remove = el('button', { type: 'button', className: 'danger', text: 'Remove' });
    remove.addEventListener('click', () => {
      if (!confirm(`Remove "${source.name}"? Any scenario override pointing at it will be reported as incomplete.`)) return;
      store.update((draft) => {
        draft.sources = draft.sources.filter((s) => s.id !== source.id);
      });
    });
    header.append(remove);
    card.append(header);

    card.append(renderSourceForm(source, (mutate) => store.update(mutate)));
    root.append(card);
  }

  return root;
}

/* -------------------------------------------------------------------------- */
/* Taxes                                                                       */
/* -------------------------------------------------------------------------- */

export function taxesView(store) {
  const run = store.run(store.scenarioId ?? 'base', 'expected');
  const root = el('div', { className: 'view view-taxes' });

  root.append(el('h2', { text: 'Taxes' }));

  const spec = buildTaxSpec(run);
  if (spec) root.append(chartFor(spec));

  root.append(renderTaxSummary(run));

  const settings = el('section', { className: 'panel' });
  settings.append(el('h3', { text: 'Setting money aside' }));
  settings.append(el('p', {
    className: 'muted',
    text: 'Income without withholding — contract work especially — leaves tax owed out of ' +
      'money already sitting in your account. Reserving it is what makes the "spendable" ' +
      'figure honest.',
  }));

  const gap = run.metrics.taxReserveGap;
  settings.append(el('p', {
    text: gap.value > 0
      ? `${money(gap.value)} of projected tax is not yet covered.`
      : 'Projected tax is fully covered by withholding, payments and what you have set aside.',
  }));
  root.append(settings);

  return root;
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

export function scenariosView(store) {
  const model = store.model;
  const root = el('div', { className: 'view view-scenarios' });

  root.append(el('h2', { text: 'Scenarios' }));
  root.append(el('p', {
    className: 'muted',
    text: 'A scenario is a short list of changes on top of your base plan — never a copy of ' +
      'it. Edit the base and every scenario follows.',
  }));

  /* presets */
  const presetPanel = el('section', { className: 'panel' });
  presetPanel.append(el('h3', { text: 'Start from a preset' }));
  presetPanel.append(el('p', {
    className: 'muted',
    text: 'Presets write ordinary, visible changes you can read, edit or delete one at a time.',
  }));

  const presetRow = el('div', { className: 'type-row' });
  for (const [key, spec] of Object.entries(PRESETS)) {
    const button = el('button', { type: 'button', className: 'type-button', text: spec.label });
    button.title = spec.description;
    button.addEventListener('click', () => {
      store.update((draft) => {
        const scenario = buildPresetScenario(draft, key);
        draft.scenarios = draft.scenarios.filter((s) => s.id !== scenario.id);
        draft.scenarios.push(scenario);
      });
      store.setScenario(`preset-${key}`);
    });
    presetRow.append(button);
  }
  presetPanel.append(presetRow);
  root.append(presetPanel);

  /* the scenarios themselves */
  if (model.scenarios.length === 0) {
    root.append(el('p', { className: 'muted', text: 'No scenarios yet.' }));
    return root;
  }

  const base = store.run('base', 'expected');

  for (const scenario of model.scenarios) {
    const card = el('section', { className: 'panel' });
    const header = el('div', { className: 'source-header' });
    header.append(el('h3', { text: scenario.name }));

    const view = el('button', { type: 'button', text: 'Compare with base' });
    view.addEventListener('click', () => store.setScenario(scenario.id));
    header.append(view);

    const remove = el('button', { type: 'button', className: 'danger', text: 'Delete' });
    remove.addEventListener('click', () => {
      store.update((draft) => {
        draft.scenarios = draft.scenarios.filter((s) => s.id !== scenario.id);
      });
      if (store.scenarioId === scenario.id) store.setScenario('base');
    });
    header.append(remove);
    card.append(header);

    if (scenario.description) card.append(el('p', { className: 'muted', text: scenario.description }));

    let run;
    try {
      run = store.run(scenario.id, 'expected');
    } catch (err) {
      card.append(el('p', { className: 'notice notice-error', text: err.message }));
      root.append(card);
      continue;
    }

    if (isIncomplete(run.overrideReport)) {
      card.append(el('p', {
        className: 'notice notice-error',
        text: 'Some changes in this scenario could not be applied, so this comparison is ' +
          'incomplete — it is showing base numbers for those items.',
      }));
    }

    /* the changes, in plain language */
    const list = el('ul', { className: 'override-list' });
    for (const entry of run.overrideReport) {
      const item = el('li', { className: `override override-${entry.status}` });
      item.append(el('span', { className: 'override-path', text: entry.note || `${entry.path}` }));
      if (entry.status === 'applied') {
        item.append(el('span', { className: 'muted', text: ` ${format(entry.before)} → ${format(entry.after)}` }));
      } else {
        item.append(el('span', { className: 'warning-severity', text: ` — ${entry.status}` }));
      }
      list.append(item);
    }
    if (run.overrideReport.length > 0) card.append(list);

    card.append(renderAttributionPanel(
      attribute(base, run, { metric: 'netWorth', groupBy: 'source' }),
    ));

    const compare = buildCompareSpec(new Map([['Base', base], [scenario.name, run]]), { metric: 'liquid' });
    card.append(chartFor(compare));

    root.append(card);
  }

  return root;
}

const format = (value) => {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'number') return Math.abs(value) >= 1000 ? money(value) : String(value);
  return String(value);
};

/* -------------------------------------------------------------------------- */
/* Assumptions                                                                 */
/* -------------------------------------------------------------------------- */

export function assumptionsView(store) {
  const model = store.model;
  const root = el('div', { className: 'view view-assumptions' });

  root.append(el('h2', { text: 'Assumptions' }));
  root.append(el('p', {
    className: 'muted',
    text: 'Everything the projection takes for granted, in one place.',
  }));

  const panel = el('section', { className: 'panel' });
  const grid = el('div', { className: 'field-grid' });

  grid.append(numberField('Projection length (years)', model.horizon?.years ?? 5, 1, 50, (value) => {
    store.update((draft) => { draft.horizon = { ...draft.horizon, years: value }; });
  }));

  grid.append(numberField('Emergency reserve (months of essentials)', model.emergencyTargetMonths ?? 3, 0, 24, (value) => {
    store.update((draft) => { draft.emergencyTargetMonths = value; });
  }));

  grid.append(numberField('Tax set aside from untaxed income (%)',
    Math.round((model.taxReserveRate ?? 0) * 100), 0, 100, (value) => {
      store.update((draft) => { draft.taxReserveRate = value / 100; });
    }));

  panel.append(grid);

  const filing = el('div', { className: 'field' });
  const filingId = 'filing-status';
  filing.append(el('label', { for: filingId, text: 'Filing status' }));
  const select = el('select', { id: filingId });
  for (const [value, label] of [
    ['single', 'Single'],
    ['married_joint', 'Married filing jointly'],
    ['married_separate', 'Married filing separately'],
    ['head_of_household', 'Head of household'],
  ]) {
    const option = el('option', { value, text: label });
    if (model.household.filingStatus === value) option.selected = true;
    select.append(option);
  }
  select.addEventListener('change', () => {
    store.update((draft) => { draft.household.filingStatus = select.value; });
  });
  filing.append(select);
  panel.append(filing);

  root.append(panel);

  const run = store.run('base', 'expected');
  const registry = el('section', { className: 'panel' });
  registry.append(el('h3', { text: 'What the projection currently assumes' }));

  const rows = model.sources
    .filter((s) => s.enabled)
    .map((s) => {
      const growth = s.details.growthRate ?? s.details.inflationRate;
      return growth ? `${s.name}: grows ${(growth * 100).toFixed(1)}% a year` : null;
    })
    .filter(Boolean);

  if (rows.length === 0) {
    registry.append(el('p', { className: 'muted', text: 'Nothing is set to grow or shrink over time.' }));
  } else {
    const list = el('ul');
    for (const row of rows) list.append(el('li', { text: row }));
    registry.append(list);
  }

  registry.append(el('p', {
    className: 'muted',
    text: `The projection covers ${plural(run.months.length, 'month')}, ` +
      `from ${periodLabel(run.months[0]?.period)} to ${periodLabel(run.months[run.months.length - 1]?.period)}.`,
  }));
  root.append(registry);

  return root;
}

function numberField(label, value, min, max, onChange) {
  const id = `n-${label.replace(/\W+/g, '-').toLowerCase()}`;
  const wrapper = el('div', { className: 'field' });
  wrapper.append(el('label', { for: id, text: label }));
  const input = el('input', { id, type: 'number', min: String(min), max: String(max), step: '1' });
  input.value = String(value);
  input.addEventListener('change', () => {
    const next = Number(input.value);
    if (Number.isFinite(next)) onChange(next);
  });
  wrapper.append(input);
  return wrapper;
}
