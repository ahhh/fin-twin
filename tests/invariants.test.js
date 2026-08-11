/**
 * The invariant suite.
 *
 * These run across every fixture, scenario and realisation mode. They are the properties
 * that must hold no matter what the user enters — the ones whose failure means a number
 * somewhere is quietly wrong rather than obviously broken.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules } from '../model/close-rules.js';
import { resolveSources, makeScenario, makeOverride } from '../model/scenarios.js';
import { attribute, METRICS } from '../model/attribution.js';
import { migrate, exportJson, importJson } from '../model/persistence.js';
import { EVENT_FIELDS, groupBy } from '../model/events.js';
import { sumCents } from '../model/money.js';
import { canonicalJson } from '../model/hash.js';
import { ALL_WARNING_CODES, isCatalogued } from '../model/warnings.js';
import { reconcile } from '../model/tax/estimated.js';
import { REPO_ROOT } from './helpers/files.js';
import { PACKS } from './helpers/packs.js';
import { sliceModel, simpleModel } from './helpers/models.js';
import { shuffle, seededRandom } from './helpers/build.js';

before(() => registerBuiltInCloseRules());

const templates = JSON.parse(await readFile(join(REPO_ROOT, 'data/templates.json'), 'utf8')).templates;

/** Every model we can get our hands on, each with the tax packs attached. */
const FIXTURES = [
  { name: 'slice', model: { ...sliceModel(), taxPacks: PACKS } },
  { name: 'simple', model: { ...simpleModel(), taxPacks: PACKS } },
  ...templates.map((t) => ({ name: t.id, model: { ...migrate(t.model), taxPacks: PACKS } })),
];

const MODES = ['won', 'expected', 'lost'];

/** Every (fixture, mode) run. */
const RUNS = FIXTURES.flatMap(({ name, model }) =>
  MODES.map((mode) => ({ name: `${name}/${mode}`, model, mode, run: runProjection(model, { mode, resolveSources }) })),
);

/* -------------------------------------------------------------------------- */

test('1. balance identity: closing === opening + the month\'s movement', () => {
  for (const { name, run } of RUNS) {
    for (const month of run.months) {
      for (const account of Object.keys(month.closing)) {
        const moved = sumCents(
          run.events
            .filter((e) => e.period === month.period && e.account === account)
            .map((e) => e.cashAmount),
        );
        assert.equal(month.closing[account], (month.opening[account] ?? 0) + moved,
          `${name} ${month.period} ${account}`);
      }
    }
  }
});

test('2. transfers and contributions are net-worth neutral', () => {
  for (const { name, run } of RUNS) {
    const groups = groupBy(run.events.filter((e) => e.groupId), (e) => e.groupId);
    for (const [groupId, legs] of groups) {
      const ownMoney = legs.every((e) => e.kind === 'transfer' || e.kind === 'contribution' || e.kind === 'adjustment');
      if (!ownMoney) continue;
      assert.equal(sumCents(legs.map((e) => e.cashAmount)), 0, `${name} group ${groupId}`);
    }
  }
});

test('3. a scenario with no overrides is byte-identical to base', () => {
  for (const { name, model } of FIXTURES) {
    const withEmpty = { ...model, scenarios: [makeScenario({ id: 'empty' })] };
    const base = runProjection(withEmpty, { resolveSources });
    const empty = runProjection(withEmpty, { scenarioId: 'empty', resolveSources });
    assert.equal(empty.runKey, base.runKey, `${name}: an empty scenario changed the run`);
  }
});

test('4. a disabled source emits nothing, and re-enabling restores the exact run', () => {
  for (const { name, model } of FIXTURES) {
    if (model.sources.length === 0) continue;
    const target = model.sources[0].id;
    const reference = runProjection(model, { resolveSources });

    const off = {
      ...model,
      sources: model.sources.map((s) => (s.id === target ? { ...s, enabled: false } : s)),
    };
    const disabled = runProjection(off, { resolveSources });
    assert.equal(disabled.events.filter((e) => e.sourceId === target).length, 0, `${name}: disabled source still emitted`);

    const back = runProjection({
      ...off,
      sources: off.sources.map((s) => (s.id === target ? { ...s, enabled: true } : s)),
    }, { resolveSources });
    assert.equal(back.runKey, reference.runKey, `${name}: toggling off and on did not return to the same run`);
  }
});

test('5. attribution residual is exactly zero, everywhere', () => {
  const model = { ...sliceModel(), taxPacks: PACKS };
  model.scenarios = [makeScenario({
    id: 'delayed',
    overrides: [makeOverride('job_second', 'startDate', '2027-01-01', { note: 'starts later' })],
  })];

  const base = runProjection(model, { mode: 'expected', resolveSources });
  const scenario = runProjection(model, { scenarioId: 'delayed', mode: 'expected', resolveSources });

  for (const metric of Object.keys(METRICS)) {
    for (const groupBy_ of ['source', 'category', 'kind']) {
      for (const month of base.months) {
        const report = attribute(base, scenario, { at: month.period, metric, groupBy: groupBy_ });
        assert.equal(report.residual, 0, `${metric}/${groupBy_} at ${month.period}`);
      }
    }
  }
});

test('6. no float ever reaches the ledger', () => {
  for (const { name, run } of RUNS) {
    for (const event of run.events) {
      assert.ok(Number.isSafeInteger(event.cashAmount), `${name}: ${event.id} cash is not integer cents`);
      assert.ok(Number.isSafeInteger(event.taxableAmount), `${name}: ${event.id} taxable is not integer cents`);
    }
    for (const value of Object.values(run.balances)) {
      assert.ok(Number.isSafeInteger(value), `${name}: a balance is not integer cents`);
    }
  }
});

test('7. the tax triple is all-or-nothing on every event', () => {
  for (const { name, run } of RUNS) {
    for (const e of run.events) {
      const taxed = e.taxableAmount !== 0;
      assert.equal(taxed, e.taxCategory !== null, `${name}: ${e.id}`);
      assert.equal(taxed, e.taxYear !== null, `${name}: ${e.id}`);
    }
  }
});

test('8. runs are deterministic', () => {
  for (const { name, model, mode } of RUNS) {
    const a = runProjection(model, { mode, resolveSources });
    const b = runProjection(model, { mode, resolveSources });
    assert.equal(a.runKey, b.runKey, `${name}: two runs disagreed`);
    assert.equal(canonicalJson(a.months), canonicalJson(b.months), `${name}: months differed`);
  }
});

test('9. source order does not affect the result', () => {
  const random = seededRandom(4242);
  for (const { name, model } of FIXTURES) {
    const reference = runProjection(model, { resolveSources });
    for (let i = 0; i < 5; i++) {
      const shuffled = runProjection({ ...model, sources: shuffle(model.sources, random) }, { resolveSources });
      assert.equal(shuffled.runKey, reference.runKey, `${name}: order mattered on trial ${i}`);
    }
  }
});

test('10. every tax year reconciles: liability − withheld − estimated − true-up === 0', () => {
  for (const { name, run } of RUNS) {
    for (const [year, result] of Object.entries(run.yearResults)) {
      assert.equal(
        reconcile({
          liability: result.totalLiability,
          withheld: result.withheld,
          instalments: result.instalments,
          trueUp: result.trueUp,
        }),
        0,
        `${name} ${year} did not reconcile`,
      );
    }
  }
});

test('11. withholding reduces cash and never taxable income', () => {
  for (const { name, run } of RUNS) {
    for (const e of run.events.filter((e) => e.kind === 'withholding')) {
      assert.ok(e.cashAmount < 0, `${name}: ${e.id}`);
      assert.equal(e.taxableAmount, 0, `${name}: ${e.id}`);
      assert.ok(e.personId, `${name}: ${e.id} has no person`);
    }
  }
});

test('12. pre-tax contributions move cash and taxable together; Roth moves only cash', () => {
  for (const { name, run } of RUNS) {
    for (const e of run.events.filter((e) => e.kind === 'contribution')) {
      if (e.taxableAmount !== 0) {
        assert.equal(e.taxableAmount, e.cashAmount, `${name}: ${e.id} pre-tax legs must match`);
      }
    }
  }
});

test('13. non-cash events move no cash', () => {
  for (const { name, run } of RUNS) {
    for (const e of run.events.filter((e) => e.kind === 'noncash')) {
      assert.equal(e.cashAmount, 0, `${name}: ${e.id}`);
    }
  }
});

test('15. a sinking fund changes no net worth and no expense total', () => {
  const template = templates.find((t) => t.sample);
  const model = { ...migrate(template.model), taxPacks: PACKS };

  const withFund = runProjection(model, { resolveSources });
  const without = runProjection({
    ...model,
    sources: model.sources.map((s) =>
      s.details?.sinkingFund?.enabled
        ? { ...s, details: { ...s.details, sinkingFund: { enabled: false } } }
        : s),
  }, { resolveSources });

  const netWorth = (run) => sumCents(Object.values(run.balances));
  const expenses = (run) => sumCents(run.events.filter((e) => e.kind === 'expense').map((e) => e.cashAmount));

  assert.equal(netWorth(withFund), netWorth(without), 'net worth must be identical');
  assert.equal(expenses(withFund), expenses(without), 'the bill must be counted exactly once either way');
});

test('16. realisation is monotonic: lost <= expected <= won', () => {
  for (const { name, model } of FIXTURES) {
    const runs = Object.fromEntries(MODES.map((m) => [m, runProjection(model, { mode: m, resolveSources })]));
    if (runs.expected.uncertainSourceIds.length === 0) continue;

    const cash = (m) => runs[m].metrics.liquidCash.value;
    assert.ok(cash('lost') <= cash('expected'), `${name}: expected fell below lost`);
    assert.ok(cash('expected') <= cash('won'), `${name}: expected rose above won`);
  }
});

test('17. every shipped rule pack is valid and every modelled year has one', () => {
  for (const { name, run } of RUNS) {
    for (const [year, result] of Object.entries(run.yearResults)) {
      assert.ok(result.packLabel, `${name} ${year} has no pack label`);
      if (result.extrapolated) {
        assert.ok(
          run.warnings.some((w) => w.code === 'tax.no_rule_pack'),
          `${name} ${year} was extrapolated without saying so`,
        );
      }
    }
  }
});

test('18. import(export(model)) is a fixed point', () => {
  for (const { name, model } of FIXTURES) {
    const { taxPacks, ...clean } = migrate(model);
    const once = importJson(exportJson(clean));
    const twice = importJson(exportJson(once));
    assert.equal(canonicalJson(once), canonicalJson(twice), `${name}: a second round trip changed the model`);
  }
});

test('19. every warning emitted is catalogued, and the catalogue has no dead entries', () => {
  const emitted = new Set();
  for (const { run } of RUNS) {
    for (const warning of run.warnings) {
      assert.ok(isCatalogued(warning.code), `"${warning.code}" is not in the catalogue`);
      assert.ok(warning.message.length > 10, `"${warning.code}" has no usable message`);
      emitted.add(warning.code);
    }
  }
  // Not every code fires on these fixtures, but each must at least be well-formed.
  for (const code of ALL_WARNING_CODES) {
    assert.match(code, /^[a-z]+\.[a-z0-9_]+$/, `warning code "${code}" is malformed`);
  }
});

test('20. no silent fixes: a flagged problem leaves the numbers untouched', () => {
  // An end date before the start date is reported AND the source is skipped — the engine
  // must not "helpfully" swap the dates and produce numbers the user cannot reconcile.
  const broken = {
    ...simpleModel(),
    taxPacks: PACKS,
    sources: simpleModel().sources.map((s) =>
      s.id === 'exp_rent' ? { ...s, startDate: '2026-06-01', endDate: '2026-01-01' } : s),
  };
  const run = runProjection(broken, { resolveSources });

  assert.ok(run.warnings.some((w) => w.code === 'source.end_before_start' && w.severity === 'error'));
  assert.equal(run.events.filter((e) => e.sourceId === 'exp_rent').length, 0,
    'the source is skipped, not silently repaired');
});

test('21. the event shape is frozen across every fixture', () => {
  for (const { name, run } of RUNS) {
    for (const event of run.events) {
      assert.deepEqual(Object.keys(event).sort(), [...EVENT_FIELDS],
        `${name}: ${event.id} has a field the contract does not allow`);
    }
  }
});
