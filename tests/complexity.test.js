/**
 * Simple mode.
 *
 * The property that matters most here is that hiding is never losing: switching to simple
 * mode changes what is on screen and nothing about the numbers.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_LEVEL, LEVELS, advancedPrompts, isAdvanced, kpiAllowed, panelAllowed,
  unsupportedInSimple, viewAllowed, viewsFor,
} from '../model/complexity.js';
import { complexityOf, listSourceTypes, sourceTypesByFamily } from '../model/sources/index.js';
import { emptyModel, migrate } from '../model/persistence.js';
import { runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules } from '../model/close-rules.js';
import { resolveSources } from '../model/scenarios.js';
import { installFakeDom } from './helpers/dom.js';
import { REPO_ROOT } from './helpers/files.js';
import { aSource, simpleModel } from './helpers/models.js';

before(() => registerBuiltInCloseRules());

const templates = JSON.parse(await readFile(join(REPO_ROOT, 'data/templates.json'), 'utf8')).templates;

/* ---- the default ---- */

test('a new model starts simple', () => {
  assert.equal(DEFAULT_LEVEL, 'simple');
  assert.equal(emptyModel().complexity, 'simple');
  assert.equal(isAdvanced(emptyModel()), false);
  assert.deepEqual(LEVELS, ['simple', 'advanced']);
});

test('a model with no complexity set at all is treated as simple', () => {
  // Belt and braces: every reader defaults rather than assuming the field is present.
  assert.equal(isAdvanced({}), false);
  assert.equal(isAdvanced(undefined), false);
});

test('simple mode offers three sections; advanced adds the rest', () => {
  assert.deepEqual(viewsFor({ complexity: 'simple' }), ['dashboard', 'income', 'expenses']);
  assert.deepEqual(
    viewsFor({ complexity: 'advanced' }),
    ['dashboard', 'income', 'expenses', 'taxes', 'scenarios', 'assumptions'],
  );

  assert.equal(viewAllowed({ complexity: 'simple' }, 'taxes'), false);
  assert.equal(viewAllowed({ complexity: 'advanced' }, 'taxes'), true);
  assert.equal(viewAllowed({ complexity: 'simple' }, 'nonsense'), false,
    'an unknown view is treated as advanced rather than shown by accident');
});

/* ---- source types ---- */

test('simple mode offers only a salary and an expense', () => {
  const simple = listSourceTypes({ complexity: 'simple' }).map((d) => d.type);
  assert.deepEqual(simple, ['expense', 'salary']);

  const all = listSourceTypes().map((d) => d.type);
  assert.ok(all.length > simple.length);
  for (const advanced of ['contract', 'loan', 'asset', 'transfer']) {
    assert.ok(all.includes(advanced), `${advanced} should still exist`);
    assert.equal(complexityOf(advanced), 'advanced');
  }
});

test('a type that forgets to declare its level is treated as advanced', () => {
  // Failing closed matters: a new type leaking into simple mode is the failure that would
  // go unnoticed, because everything would still work — just be more cluttered.
  assert.equal(complexityOf('does-not-exist'), 'advanced');
});

test('the add-item picker is filtered by level', () => {
  const simple = sourceTypesByFamily({ complexity: 'simple' });
  const advanced = sourceTypesByFamily({ complexity: 'advanced' });

  assert.deepEqual([...simple.get('income')].map((d) => d.type), ['salary']);
  assert.ok([...advanced.get('income')].map((d) => d.type).includes('contract'));
  assert.equal(simple.has('liability'), false, 'no loans in simple mode');
  assert.ok(advanced.has('liability'));
});

/* ---- hiding is not losing ---- */

test('switching mode changes nothing about the numbers', () => {
  // The load-bearing property. Complexity is a view setting; the engine never reads it.
  const base = simpleModel();
  const asSimple = runProjection({ ...base, complexity: 'simple' }, { resolveSources });
  const asAdvanced = runProjection({ ...base, complexity: 'advanced' }, { resolveSources });

  assert.equal(asSimple.runKey, asAdvanced.runKey, 'the projection must be identical');
  assert.deepEqual(asSimple.balances, asAdvanced.balances);
});

test('an advanced source still affects the projection while simple mode hides it', () => {
  const withContract = {
    ...simpleModel(),
    complexity: 'simple',
    sources: [
      ...simpleModel().sources,
      aSource('contract', {
        id: 'gig', name: 'Side work', personId: 'p1',
        startDate: '2026-03-01', endDate: '2026-03-01',
        details: { amount: 10_000_00, frequency: 'once', paymentLagDays: 30 },
      }),
    ],
  };
  const run = runProjection(withContract, { resolveSources });

  assert.ok(run.events.some((e) => e.sourceId === 'gig'),
    'the contract is still in the projection, it is only hidden from the picker');

  const hidden = unsupportedInSimple(withContract, complexityOf);
  assert.deepEqual(hidden, ['contract'], 'and the UI is told to say so');
});

test('nothing is reported as hidden once advanced mode is on', () => {
  const model = { ...simpleModel(), complexity: 'advanced', sources: [aSource('loan', { id: 'l', startDate: '2026-01-01' })] };
  assert.deepEqual(unsupportedInSimple(model, complexityOf), []);
});

/* ---- panels and tiles ---- */

test('the dashboard drops the composition chart and the uncertainty strip in simple mode', () => {
  const simple = { complexity: 'simple' };
  const advanced = { complexity: 'advanced' };

  for (const panel of ['kpis', 'cashChart', 'timelineChart', 'upcoming', 'warnings']) {
    assert.equal(panelAllowed(simple, panel), true, `${panel} should survive in simple mode`);
  }
  assert.equal(panelAllowed(simple, 'incomeComposition'), false);
  assert.equal(panelAllowed(simple, 'uncertaintyStrip'), false);
  assert.equal(panelAllowed(advanced, 'uncertaintyStrip'), true);
});

test('simple mode shows four tiles, not six', () => {
  const simple = { complexity: 'simple' };
  assert.equal(kpiAllowed(simple, 'liquidCash'), true);
  assert.equal(kpiAllowed(simple, 'monthlySurplus'), true);
  assert.equal(kpiAllowed(simple, 'spendableCash'), false,
    'spendable-after-tax is meaningless without untaxed income');
  assert.equal(kpiAllowed(simple, 'incomeConcentration'), false);
});

/* ---- staged prompts ---- */

test('a plain salary plan is not nagged', () => {
  assert.deepEqual(advancedPrompts(simpleModel()), []);
});

test('the prompt appears when the plan actually outgrows simple mode', () => {
  const withContract = {
    ...simpleModel(),
    complexity: 'simple',
    sources: [aSource('contract', {
      id: 'gig', startDate: '2026-01-01', details: { amount: 5_000_00, frequency: 'monthly' },
    })],
  };
  const prompts = advancedPrompts(withContract);

  assert.ok(prompts.some((p) => p.id === 'untaxed-income'));
  assert.match(prompts[0].message, /not taxed at source/i,
    'the reason is given in the user\'s terms, not as "enable advanced features"');
});

test('uncertainty and scenarios each earn their own prompt', () => {
  const uncertain = {
    ...simpleModel(),
    complexity: 'simple',
    sources: [aSource('salary', {
      id: 'maybe', startDate: '2026-01-01',
      certainty: { mode: 'probability', confidence: 0.5 },
      details: { annualAmount: 50_000_00 },
    })],
  };
  assert.ok(advancedPrompts(uncertain).some((p) => p.id === 'uncertainty'));

  const scenarios = { ...simpleModel(), complexity: 'simple', scenarios: [{ id: 's', name: 'S', overrides: [] }] };
  assert.ok(advancedPrompts(scenarios).some((p) => p.id === 'scenarios'));
});

test('advanced mode is never prompted at', () => {
  const busy = {
    ...simpleModel(),
    complexity: 'advanced',
    scenarios: [{ id: 's', name: 'S', overrides: [] }],
    sources: [aSource('contract', { id: 'gig', startDate: '2026-01-01', details: { amount: 5_000_00 } })],
  };
  assert.deepEqual(advancedPrompts(busy), []);
});

/* ---- migration ---- */

test('an older plan containing advanced items opens in advanced mode', () => {
  // Demoting somebody's existing plan and hiding half of it would be the worse default.
  const legacy = migrate({
    schemaVersion: 0,
    sources: [{ type: 'salary' }, { type: 'loan' }],
    horizon: { startDate: '2026-01-01', years: 5 },
  });
  assert.equal(legacy.complexity, 'advanced');
});

test('an older plain plan opens simple', () => {
  const legacy = migrate({
    schemaVersion: 0,
    sources: [{ type: 'salary' }, { type: 'expense' }],
    horizon: { startDate: '2026-01-01', years: 5 },
  });
  assert.equal(legacy.complexity, 'simple');
});

test('an explicit setting always wins over the guess', () => {
  const explicit = migrate({
    schemaVersion: 1, complexity: 'simple',
    sources: [{ type: 'loan' }], horizon: { startDate: '2026-01-01', years: 5 },
  });
  assert.equal(explicit.complexity, 'simple');
});

/* ---- the first-run sample ---- */

test('the first-run sample is the simple one', () => {
  const sample = templates.find((t) => t.sample);
  assert.equal(sample.id, 'just-getting-started');
  assert.equal(sample.complexity, 'simple');
  assert.equal(sample.model.complexity, 'simple');

  const types = new Set(sample.model.sources.map((s) => s.type));
  for (const type of types) {
    assert.equal(complexityOf(type), 'simple',
      `the first thing a new user sees must not contain a ${type}`);
  }
});

test('the freelancer showcase is still available, just not first', () => {
  const showcase = templates.find((t) => t.id === 'freelancer-plus-salary');
  assert.ok(showcase, 'the advanced demo should still ship');
  assert.equal(showcase.sample, undefined);
  assert.equal(showcase.complexity, 'advanced');
});

/* ---- rendering ---- */

test('simple mode renders a smaller dashboard, and advanced adds to it', async () => {
  const dom = installFakeDom();
  try {
    const views = await import('../ui/views.js');

    const make = (complexity) => {
      const model = {
        ...simpleModel(),
        complexity,
        sources: [
          ...simpleModel().sources,
          aSource('contract', {
            id: 'gig', name: 'Side work', personId: 'p1',
            startDate: '2026-03-01', endDate: '2026-03-01',
            certainty: { mode: 'probability', confidence: 0.5 },
            details: { amount: 10_000_00, frequency: 'once', paymentLagDays: 30 },
          }),
        ],
      };
      const cache = new Map();
      return {
        model,
        scenarioId: 'base',
        run(scenarioId = 'base', mode = 'expected') {
          const key = `${scenarioId}:${mode}`;
          if (!cache.has(key)) cache.set(key, runProjection(model, { scenarioId, mode, resolveSources }));
          return cache.get(key);
        },
        runComparison() {
          return new Map([['If it lands', this.run('base', 'won')], ['If it does not', this.run('base', 'lost')]]);
        },
        setComplexity() {},
        update() {},
      };
    };

    const simple = views.dashboardView(make('simple'));
    const advanced = views.dashboardView(make('advanced'));

    const simpleText = simple.text();
    const advancedText = advanced.text();

    // Checked against markup unique to the strip, not its prose: the advanced-mode PROMPT
    // also mentions things that might not happen, and a looser match collides with it.
    assert.doesNotMatch(simpleText, /If it lands/, 'no uncertainty strip in simple mode');
    assert.doesNotMatch(simpleText, /not the same as half of it arriving/i);
    assert.match(advancedText, /If it lands/);
    assert.match(advancedText, /not the same as half of it arriving/i);

    assert.doesNotMatch(simpleText, /Where income comes from/i, 'no composition chart in simple mode');
    assert.match(advancedText, /Where income comes from/i);

    // But it does say that something is not being shown, and offers the way forward.
    assert.match(simpleText, /not on screen/i);
    assert.match(simpleText, /Turn on advanced features/i);

    assert.ok(
      simple.querySelectorAll('.kpi').length < advanced.querySelectorAll('.kpi').length,
      'simple mode should show fewer tiles',
    );
  } finally {
    dom.restore();
  }
});
