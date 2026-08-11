import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules } from '../model/close-rules.js';
import { resolveSources, makeScenario, makeOverride, isIncomplete } from '../model/scenarios.js';
import { attribute, attributionToText, renderAttribution, METRICS } from '../model/attribution.js';
import { sliceModel } from './helpers/models.js';

before(() => registerBuiltInCloseRules());

/** The slice with a job-change scenario: the new job starts three months later. */
function modelWithScenario(overrides = []) {
  const model = sliceModel();
  model.scenarios = [
    makeScenario({
      id: 'delayed-start',
      name: 'New job starts later',
      overrides: overrides.length > 0 ? overrides : [
        makeOverride('job_second', 'startDate', '2027-01-01', {
          note: 'Second Job now starts 2027-01-01',
        }),
      ],
    }),
  ];
  return model;
}

const runBoth = (model, scenarioId = 'delayed-start', mode = 'lost') => ({
  base: runProjection(model, { mode, resolveSources }),
  scenario: runProjection(model, { scenarioId, mode, resolveSources }),
});

/* ---- scenario resolution ---- */

test('a scenario with no overrides is byte-identical to base', () => {
  // The early return in resolveSources is the proof of this, not an optimisation.
  const model = sliceModel();
  model.scenarios = [makeScenario({ id: 'empty', name: 'Empty' })];

  const base = runProjection(model, { resolveSources });
  const empty = runProjection(model, { scenarioId: 'empty', resolveSources });

  assert.equal(empty.runKey, base.runKey, 'identical run key, not merely similar numbers');
  assert.deepEqual(empty.months, base.months);
});

test('an override changes the resolved source and nothing else', () => {
  const model = modelWithScenario();
  const { sources, report } = resolveSources(model, 'delayed-start');

  assert.equal(sources.find((s) => s.id === 'job_second').startDate, '2027-01-01');
  assert.equal(model.sources.find((s) => s.id === 'job_second').startDate, '2026-10-01',
    'the base model must not be mutated');
  assert.deepEqual(report[0], {
    overrideId: 'ovr_job_second_startDate',
    sourceId: 'job_second',
    path: 'startDate',
    note: 'Second Job now starts 2027-01-01',
    status: 'applied',
    before: '2026-10-01',
    after: '2027-01-01',
  });
});

test('an override on a mistyped path is skipped and reported, never silently created', () => {
  const model = modelWithScenario([makeOverride('job_second', 'details.growthRat', 0.5)]);
  const { sources, report, warnings } = resolveSources(model, 'delayed-start');

  assert.equal(report[0].status, 'unknown-path');
  assert.ok(isIncomplete(report), 'the scenario must be flagged incomplete');
  assert.ok(warnings.some((w) => w.code === 'scenario.unknown_path' && w.severity === 'error'));
  assert.equal(sources.find((s) => s.id === 'job_second').details.growthRat, undefined,
    'nothing was invented on the source');
});

test('an override pointing at a deleted source is reported, not thrown', () => {
  const model = modelWithScenario([makeOverride('job_deleted', 'startDate', '2027-01-01')]);
  const { report, warnings } = resolveSources(model, 'delayed-start');

  assert.equal(report[0].status, 'dangling');
  assert.ok(warnings.some((w) => w.code === 'scenario.dangling_source' && w.severity === 'error'));
  assert.ok(isIncomplete(report));
});

test('scale and delta operate on numbers; a set on a date still works', () => {
  const model = modelWithScenario([
    makeOverride('job_second', 'details.annualAmount', 0.5, { op: 'scale' }),
    makeOverride('exp_living', 'details.amount', 500_00, { op: 'delta' }),
  ]);
  const { sources } = resolveSources(model, 'delayed-start');

  assert.equal(sources.find((s) => s.id === 'job_second').details.annualAmount, 70_000_00);
  assert.equal(sources.find((s) => s.id === 'exp_living').details.amount, 7_000_00);
});

test('scaling a non-numeric field is a type mismatch, not a coerced string', () => {
  const model = modelWithScenario([makeOverride('job_second', 'startDate', 2, { op: 'scale' })]);
  const { sources, report, warnings } = resolveSources(model, 'delayed-start');

  assert.equal(report[0].status, 'type-mismatch');
  assert.ok(warnings.some((w) => w.code === 'scenario.type_mismatch'));
  assert.equal(sources.find((s) => s.id === 'job_second').startDate, '2026-10-01', 'unchanged');
});

/* ---- attribution: the architectural go/no-go ---- */

test('the residual is EXACTLY zero for every metric, month and grouping', () => {
  // This is the test the whole design stands on. A non-zero residual means something is
  // producing money outside the event stream.
  const { base, scenario } = runBoth(modelWithScenario());

  for (const metric of Object.keys(METRICS)) {
    for (const groupBy of ['source', 'category', 'kind']) {
      for (const month of base.months) {
        const report = attribute(base, scenario, { at: month.period, metric, groupBy });
        assert.equal(
          report.residual, 0,
          `residual ${report.residual} for ${metric}/${groupBy} at ${month.period}`,
        );
        assert.ok(
          !report.lines.some((l) => l.classification === 'unexplained'),
          `unexplained line for ${metric}/${groupBy} at ${month.period}`,
        );
      }
    }
  }
});

test('the residual stays zero when the runs are the same', () => {
  const base = runProjection(sliceModel(), { resolveSources });
  const report = attribute(base, base, { metric: 'netWorth' });

  assert.equal(report.delta, 0);
  assert.equal(report.residual, 0);
  assert.deepEqual(report.lines, []);
  assert.match(renderAttribution(report).headline, /unchanged/);
});

test('the sum of the reported lines equals the change, with nothing hidden in the remainder', () => {
  const { base, scenario } = runBoth(modelWithScenario());
  const report = attribute(base, scenario, { metric: 'liquidCash', topN: 2 });

  const shown = report.lines.reduce((sum, l) => sum + l.delta, 0);
  const remainder = report.remainder?.delta ?? 0;
  assert.equal(shown + remainder + report.openingDelta, report.delta,
    'top-N plus the rolled-up remainder must still close the arithmetic');
});

test('delaying the new job is attributed to that job, and names the override as the cause', () => {
  const { base, scenario } = runBoth(modelWithScenario());
  const report = attribute(base, scenario, { at: '2027-06', metric: 'netWorth' });

  assert.ok(report.delta < 0, 'three fewer months of salary leaves you worse off');

  const line = report.lines.find((l) => l.key === 'job_second');
  assert.ok(line, 'the delayed job should be the headline cause');
  assert.equal(line.classification, 'changed');
  assert.equal(line.label, 'Second Job');
  assert.equal(line.cause.path, 'startDate');
  assert.equal(line.cause.before, '2026-10-01');
  assert.equal(line.cause.after, '2027-01-01');

  const text = attributionToText(report);
  assert.match(text, /Net worth in 2027-06 is .* lower/);
  assert.match(text, /Second Job/);
  assert.match(text, /Second Job now starts 2027-01-01/, 'the override note is the explanation');
});

test('a source removed by the scenario is attributed as removed', () => {
  const model = sliceModel();
  model.scenarios = [makeScenario({ id: 'no-contract', removedSourceIds: ['contract_acme'] })];

  const base = runProjection(model, { mode: 'won', resolveSources });
  const scenario = runProjection(model, { scenarioId: 'no-contract', mode: 'won', resolveSources });

  const report = attribute(base, scenario, { metric: 'netWorth' });
  const line = report.lines.find((l) => l.key === 'contract_acme');

  assert.ok(line);
  assert.equal(line.classification, 'removed');
  assert.equal(line.delta, -40_000_00);
  assert.equal(report.residual, 0);
});

test('second-order effects show up on their own, because the engine\'s own flows are events', () => {
  // Removing the contract also removes its tax reserve. Nothing in attribution.js knows
  // what a tax reserve is — it appears because the reserve is a real event with a real
  // source id.
  const model = sliceModel();
  model.scenarios = [makeScenario({ id: 'no-contract', removedSourceIds: ['contract_acme'] })];

  const base = runProjection(model, { mode: 'won', resolveSources });
  const scenario = runProjection(model, { scenarioId: 'no-contract', mode: 'won', resolveSources });

  const report = attribute(base, scenario, { metric: 'liquidCash' });
  const derived = report.lines.find((l) => l.classification === 'derived');

  assert.ok(derived, 'the tax reserve should appear as a derived effect');
  assert.equal(derived.key, 'system:tax-reserve-earmark');
  assert.equal(derived.label, 'Tax reserve');
  assert.equal(derived.delta, 12_000_00, 'no contract means no reserve held back, so cash is higher');
});

test('an uncertain source that does not land is explained as such', () => {
  const model = sliceModel();
  const won = runProjection(model, { mode: 'won', resolveSources });
  const lost = runProjection(model, { mode: 'lost', resolveSources });

  const report = attribute(won, lost, { metric: 'netWorth' });
  const line = report.lines.find((l) => l.key === 'contract_acme');

  assert.equal(line.classification, 'removed');
  assert.equal(line.note, 'did not happen in this run');
  assert.equal(report.residual, 0);
});

test('an incomplete scenario is surfaced in the report, so nobody reads a partial comparison', () => {
  const model = modelWithScenario([makeOverride('job_missing', 'startDate', '2027-01-01')]);
  const { base, scenario } = runBoth(model);
  const report = attribute(base, scenario, { metric: 'netWorth' });

  assert.equal(report.incompleteScenario.length, 1);
  assert.match(attributionToText(report), /could not be applied/);
});

test('attribution refuses metrics it cannot express as a sum over events', () => {
  const base = runProjection(sliceModel(), { resolveSources });
  assert.throws(
    () => attribute(base, base, { metric: 'happiness' }),
    (err) => err.code === 'attribution.unknown_metric',
  );
  assert.throws(
    () => attribute(base, base, { groupBy: 'vibes' }),
    (err) => err.code === 'attribution.unknown_grouping',
  );
});
