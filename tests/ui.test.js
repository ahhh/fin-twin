/**
 * UI logic that does not need a DOM.
 *
 * The important one here is the chart/table drift guard: the table is rendered from the
 * same ChartSpec the chart draws, so the two cannot disagree — this asserts the spec's own
 * totals match the run they came from.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules } from '../model/close-rules.js';
import { resolveSources } from '../model/scenarios.js';
import { sumCash } from '../model/events.js';
import {
  buildCashSpec, buildCompareSpec, buildIncomeCompositionSpec, buildTaxSpec, buildTimelineSpec,
  specTotals,
} from '../ui/chartspecs.js';
import {
  byUnit, dateLabel, humanise, money, moneyAxis, percent, periodLabel, signedMoney,
} from '../ui/format.js';
import {
  buildPresetOverrides, buildPresetScenario, buildPresetSources,
  LIFE_EVENT_PRESETS, PRESETS,
} from '../model/presets.js';
import { isIncomplete } from '../model/scenarios.js';
import { sliceModel } from './helpers/models.js';
import { PACKS } from './helpers/packs.js';

before(() => registerBuiltInCloseRules());

const model = { ...sliceModel(), taxPacks: PACKS };
const run = runProjection(model, { mode: 'won', resolveSources });

/* ---- formatting ---- */

test('money formatting never invents or loses precision', () => {
  assert.equal(money(123_456), '$1,234.56');
  assert.equal(money(-4_510), '-$45.10');
  assert.equal(money(0), '$0.00');
  assert.equal(money(null), '—');
  assert.equal(money(123_456, { whole: true }), '$1,235');
});

test('axis labels are compact but never used for a figure you would act on', () => {
  assert.equal(moneyAxis(1_234_56), '$1.2k');
  assert.equal(moneyAxis(12_345_600), '$123k');
  assert.equal(moneyAxis(500_000_000), '$5.0M');
  assert.equal(moneyAxis(-250_000), '−$2.5k');
  assert.equal(moneyAxis(4_500), '$45');
});

test('dates format without touching Date, so no timezone can shift them', () => {
  assert.equal(periodLabel('2027-03'), 'Mar 2027');
  assert.equal(periodLabel('2026-12'), 'Dec 2026');
  assert.equal(dateLabel('2027-03-15'), '15 March 2027');
  assert.equal(periodLabel(null), '—');
});

test('percentages and units', () => {
  assert.equal(percent(0.2234), '22.3%');
  assert.equal(percent(null), '—');
  assert.equal(byUnit(123_456, 'cents'), '$1,234.56');
  assert.equal(byUnit(0.5, 'ratio'), '50%');
  assert.equal(byUnit(4.25, 'months'), '4.3 months');
  assert.equal(byUnit('2027-03', 'period'), 'Mar 2027');
});

test('direction is carried in words, not only by sign or colour', () => {
  assert.equal(signedMoney(-4_510).direction, 'down');
  assert.equal(signedMoney(4_510).direction, 'up');
  assert.equal(signedMoney(0).direction, 'no change');
  assert.match(signedMoney(-4_510).text, /^−/);
  assert.equal(humanise('system:tax-reserve-earmark'), 'Tax reserve earmark');
});

/* ---- chart specs ---- */

test('every spec has the fields the table renderer needs', () => {
  const specs = [
    buildTimelineSpec(run),
    buildCashSpec(run),
    buildIncomeCompositionSpec(run),
    buildTaxSpec(run),
  ].filter(Boolean);

  for (const spec of specs) {
    assert.ok(spec.title && spec.description, `${spec.id} is missing a title or description`);
    assert.ok(spec.labels.length > 0, `${spec.id} has no labels`);
    assert.ok(spec.series.length > 0, `${spec.id} has no series`);
    for (const series of spec.series) {
      assert.equal(series.values.length, spec.labels.length,
        `${spec.id}/${series.key} has a different number of points than labels`);
    }
  }
});

test('the disclaimer is part of the data, not the markup', () => {
  // So that tidying the CSS cannot quietly remove "estimate" from a tax figure.
  for (const spec of [buildTimelineSpec(run), buildCashSpec(run), buildTaxSpec(run)].filter(Boolean)) {
    assert.ok(spec.disclaimer, `${spec.id} carries no disclaimer`);
  }
  assert.match(buildTaxSpec(run).disclaimer, /not tax advice/i);
});

test('the chart and its table cannot disagree, because they are the same object', () => {
  const spec = buildTimelineSpec(run);
  const totals = Object.fromEntries(specTotals(spec).map((t) => [t.key, t.total]));

  // Independently recomputed from the run.
  assert.equal(totals.income, sumCash(run.events, (e) => e.kind === 'income'));
  assert.equal(totals.expense, sumCash(run.events, (e) => e.kind === 'expense'));
  assert.equal(
    totals.tax,
    sumCash(run.events, (e) => e.kind === 'withholding' || e.kind === 'tax_payment' || e.kind === 'tax_refund'),
  );
  assert.equal(totals.net, totals.income + totals.expense + totals.tax,
    'the net line must be the sum of the bars it sits over');
});

test('the cash spec marks the emergency target and zero', () => {
  const spec = buildCashSpec(run);
  const keys = spec.markers.map((m) => m.key);
  assert.ok(keys.includes('zero'));
  assert.ok(keys.includes('target'));
  assert.deepEqual(spec.series[0].values, run.months.map((m) => m.liquid));
});

test('income composition is sorted largest first, so concentration is visible', () => {
  const spec = buildIncomeCompositionSpec(run);
  for (let i = 1; i < spec.series.length; i++) {
    assert.ok(spec.series[i - 1].total >= spec.series[i].total, 'series are not sorted by size');
  }
});

test('the tax spec flags extrapolated and blended years', () => {
  const blended = runProjection(model, { mode: 'expected', resolveSources });
  const spec = buildTaxSpec(blended);
  assert.ok(
    spec.notes.some((n) => /corresponds to no single outcome/i.test(n)),
    'a blended tax figure must be labelled as such',
  );
});

test('compared scenarios differ by line style as well as colour', () => {
  const spec = buildCompareSpec(new Map([['Base', run], ['Other', run]]));
  assert.notDeepEqual(spec.series[0].dash, spec.series[1].dash,
    'scenario identity must not depend on colour alone');
  assert.notEqual(spec.series[0].pointStyle, spec.series[1].pointStyle);
});

/* ---- presets ---- */

test('presets generate visible, editable overrides rather than hidden multipliers', () => {
  const overrides = buildPresetOverrides(model, 'conservative');

  assert.ok(overrides.length > 0, 'the conservative preset changed nothing');
  for (const override of overrides) {
    assert.ok(override.note, 'every preset change must explain itself');
    assert.ok(override.sourceId && override.path, 'every change must target a real field');
    assert.match(override.note, /Conservative preset/);
  }
});

test('the conservative preset lowers the odds on uncertain work', () => {
  const overrides = buildPresetOverrides(model, 'conservative');
  const confidence = overrides.find((o) => o.path === 'certainty.confidence');
  assert.ok(confidence, 'the uncertain contract should be made less likely');
  assert.equal(confidence.value, 0.5);
});

test('the belt-tightening preset leaves essentials alone', () => {
  const withDiscretionary = {
    ...model,
    sources: [
      ...model.sources,
      {
        ...model.sources.find((s) => s.type === 'expense'),
        id: 'exp_fun',
        name: 'Fun',
        details: { ...model.sources.find((s) => s.type === 'expense').details, essential: false },
      },
    ],
  };
  const overrides = buildPresetOverrides(withDiscretionary, 'tighten');

  assert.ok(overrides.some((o) => o.sourceId === 'exp_fun'), 'discretionary spending is cut');
  assert.ok(!overrides.some((o) => o.sourceId === 'exp_living'),
    'essential spending must not be cut by a belt-tightening scenario');
});

test('a preset scenario runs and produces a different result', () => {
  const scenario = buildPresetScenario(model, 'conservative');
  const withScenario = { ...model, scenarios: [scenario] };

  const base = runProjection(withScenario, { mode: 'expected', resolveSources });
  const conservative = runProjection(withScenario, {
    scenarioId: scenario.id, mode: 'expected', resolveSources,
  });

  assert.notEqual(conservative.runKey, base.runKey);
  assert.ok(conservative.metrics.liquidCash.value < base.metrics.liquidCash.value,
    'a conservative view should not look rosier than the base plan');
  assert.ok(scenario.presetOrigin, 'the scenario records where it came from');
});

test('every preset is well-formed', () => {
  for (const key of Object.keys(PRESETS)) {
    const scenario = buildPresetScenario(model, key);
    assert.ok(scenario.name && scenario.description, `${key} is missing a label`);
    assert.equal(scenario.id, `preset-${key}`);
  }
});

test('every preset resolves cleanly and actually runs', () => {
  // A preset whose override silently failed to apply is the worst outcome available: the
  // user sees a scenario, believes they modelled a change, and gets base numbers.
  for (const key of Object.keys(PRESETS)) {
    const scenario = buildPresetScenario(model, key);
    const withScenario = { ...model, scenarios: [scenario] };
    const run = runProjection(withScenario, {
      scenarioId: scenario.id, mode: 'expected', resolveSources,
    });

    assert.ok(!isIncomplete(run.scenarioReport ?? []), `${key} has an override that did not apply`);
    for (const code of ['source.end_before_start', 'source.unknown_type', 'source.starts_after_horizon']) {
      assert.ok(!run.warnings.some((w) => w.code === code),
        `${key} generated a malformed source (${code})`);
    }
  }
});

test('you can only lose a job you currently have', () => {
  // The largest salary is not necessarily the one being paid in three months' time.
  // Ending a job before it starts makes the compiler drop it entirely, so the job-loss
  // scenario would come out richer than the base plan.
  const notYetStarted = {
    ...model,
    sources: model.sources.map((s) =>
      (s.type === 'salary' ? { ...s, startDate: '2027-01-01', endDate: null } : s)),
  };
  const overrides = buildPresetOverrides(notYetStarted, 'jobLoss');

  assert.equal(overrides.length, 0, 'nobody is being paid three months in, so nothing is lost');
});

/* ---- life events ---- */

test('every life event costs money', () => {
  // Not a truism worth skipping: an interruption modelled by ending a job that had not
  // started yet REMOVES a cost, so the "harder" scenario comes out richer than the base
  // plan. That bug is invisible unless something asserts the direction.
  for (const key of LIFE_EVENT_PRESETS) {
    const scenario = buildPresetScenario(model, key);
    const withScenario = { ...model, scenarios: [scenario] };

    const base = runProjection(withScenario, { mode: 'expected', resolveSources });
    const after = runProjection(withScenario, {
      scenarioId: scenario.id, mode: 'expected', resolveSources,
    });

    assert.ok(after.metrics.liquidCash.value < base.metrics.liquidCash.value,
      `${key} left the household better off than doing nothing`);
  }
});

test('a life event adds ordinary sources, editable like anything else', () => {
  const added = buildPresetSources(model, 'mortgage');

  assert.ok(added.length > 0);
  for (const source of added) {
    assert.ok(source.id && source.type && source.name, 'an added source is missing its identity');
    assert.ok(source.details && source.certainty, 'an added source must have the full shape');
    assert.match(source.notes, /scenario/i, 'the user has to be able to see where it came from');
  }
  assert.ok(added.some((s) => s.type === 'loan'), 'buying a house involves a mortgage');
  assert.ok(added.some((s) => s.details.category === 'property'),
    'and the running costs of owning, which are the part people leave out');
});

test('buying a house stops the rent', () => {
  const overrides = buildPresetOverrides(model, 'mortgage');
  const rent = model.sources.find((s) => s.details?.category === 'housing');

  if (rent) {
    assert.ok(overrides.some((o) => o.sourceId === rent.id && o.path === 'endDate'),
      'paying rent and a mortgage at once would make the scenario meaningless');
  }
});

test('unpaid leave stops the pay rather than charging an expense for it', () => {
  // An expense the size of the missing salary would reduce cash but not taxable income,
  // inventing a tax bill on money that was never earned.
  const scenario = buildPresetScenario(model, 'newChild');
  const leaveExpense = scenario.addedSources.find((s) => /leave/i.test(s.name) && s.type === 'expense');
  assert.equal(leaveExpense, undefined, 'lost pay must not be modelled as spending');

  const salaryIds = new Set(model.sources.filter((s) => s.type === 'salary').map((s) => s.id));
  assert.ok(scenario.overrides.some((o) => salaryIds.has(o.sourceId) && o.path === 'endDate'),
    'the salary itself has to stop');
});

test('an illness while nobody is being paid still costs what it costs', () => {
  // The medical bills do not care whether you had a job.
  const jobless = { ...model, sources: model.sources.filter((s) => s.type !== 'salary') };
  const added = buildPresetSources(jobless, 'seriousIllness');
  const overrides = buildPresetOverrides(jobless, 'seriousIllness');

  assert.equal(overrides.length, 0, 'there is no income to interrupt');
  assert.ok(added.every((s) => s.type === 'expense'));
  assert.ok(added.some((s) => s.details.category === 'healthcare'));
});

test('a job that would have ended during the break does not come back', () => {
  const fixedTerm = {
    ...model,
    sources: model.sources.map((s) =>
      (s.type === 'salary' ? { ...s, endDate: '2026-06-30' } : s)),
  };
  const added = buildPresetSources(fixedTerm, 'seriousIllness');

  assert.ok(!added.some((s) => /back to work/i.test(s.name)),
    'resuming a contract that had already expired would invent income');
});
