/**
 * Scenario presets, generated as VISIBLE overrides.
 *
 * A preset that applied invisible multipliers inside the engine would be unauditable: the
 * user could see that the numbers moved but not what moved them, and could not disagree
 * with one part of it. So "Conservative" writes a list of ordinary overrides into the
 * scenario, each with a note explaining itself. They can be edited or deleted one by one,
 * and the attribution narrative can name them as causes.
 */

import { getSourceType } from './sources/registry.js';
import { makeOverride, makeScenario } from './scenarios.js';
import { addMonths } from './dates.js';

export const PRESETS = Object.freeze({
  conservative: {
    label: 'Conservative',
    description: 'Income grows more slowly, costs rise faster, and uncertain work is less likely to land.',
    knobs: {
      incomeGrowthFactor: 0.5,
      expenseGrowthFactor: 1.5,
      confidenceCap: 0.5,
      healthcareUplift: 0.15,
    },
  },
  optimistic: {
    label: 'Optimistic',
    description: 'Income grows faster, costs rise more slowly, and uncertain work lands.',
    knobs: {
      incomeGrowthFactor: 1.5,
      expenseGrowthFactor: 0.7,
      confidenceFloor: 0.9,
      healthcareUplift: 0,
    },
  },
  jobLoss: {
    label: 'Job loss',
    description: 'The largest salary stops in three months and nothing replaces it.',
    knobs: { monthsUntilLoss: 3 },
  },
  tighten: {
    label: 'Cut back',
    description: 'Discretionary spending drops by a quarter; essentials are untouched.',
    knobs: { discretionaryCut: 0.25 },
  },
});

/**
 * Build the overrides a preset implies for a given model.
 *
 * @returns {Array} overrides, each carrying a note that explains it in plain language
 */
export function buildPresetOverrides(model, preset, knobs = {}) {
  const spec = PRESETS[preset];
  if (!spec) throw new Error(`unknown preset "${preset}"`);
  const k = { ...spec.knobs, ...knobs };

  const overrides = [];
  const canOverride = (source, path) =>
    getSourceType(source.type).overridablePaths.includes(path);

  for (const source of model.sources ?? []) {
    if (!source.enabled) continue;

    /* growth rates */
    if (k.incomeGrowthFactor !== undefined && source.type === 'salary'
        && canOverride(source, 'details.growthRate') && source.details.growthRate) {
      overrides.push(makeOverride(source.id, 'details.growthRate', k.incomeGrowthFactor, {
        op: 'scale',
        note: `${spec.label} preset: pay rises scaled to ${Math.round(k.incomeGrowthFactor * 100)}%`,
      }));
    }

    if (k.expenseGrowthFactor !== undefined && source.type === 'expense'
        && canOverride(source, 'details.inflationRate') && source.details.inflationRate) {
      overrides.push(makeOverride(source.id, 'details.inflationRate', k.expenseGrowthFactor, {
        op: 'scale',
        note: `${spec.label} preset: costs rise ${Math.round(k.expenseGrowthFactor * 100)}% as fast`,
      }));
    }

    /* uncertain work */
    if (source.certainty?.mode === 'probability' && canOverride(source, 'certainty.confidence')) {
      const current = source.certainty.confidence ?? 1;
      if (k.confidenceCap !== undefined && current > k.confidenceCap) {
        overrides.push(makeOverride(source.id, 'certainty.confidence', k.confidenceCap, {
          note: `${spec.label} preset: chance of landing cut to ${Math.round(k.confidenceCap * 100)}%`,
        }));
      }
      if (k.confidenceFloor !== undefined && current < k.confidenceFloor) {
        overrides.push(makeOverride(source.id, 'certainty.confidence', k.confidenceFloor, {
          note: `${spec.label} preset: chance of landing raised to ${Math.round(k.confidenceFloor * 100)}%`,
        }));
      }
    }

    /* healthcare costs */
    if (k.healthcareUplift && source.type === 'expense'
        && source.details.category === 'healthcare' && canOverride(source, 'details.amount')) {
      overrides.push(makeOverride(source.id, 'details.amount', 1 + k.healthcareUplift, {
        op: 'scale',
        note: `${spec.label} preset: healthcare up ${Math.round(k.healthcareUplift * 100)}%`,
      }));
    }

    /* belt-tightening — essentials are deliberately untouched */
    if (k.discretionaryCut && source.type === 'expense'
        && source.details.essential !== true && canOverride(source, 'details.amount')) {
      overrides.push(makeOverride(source.id, 'details.amount', 1 - k.discretionaryCut, {
        op: 'scale',
        note: `${spec.label} preset: discretionary spending cut ${Math.round(k.discretionaryCut * 100)}%`,
      }));
    }
  }

  /* job loss targets the single largest salary */
  if (k.monthsUntilLoss !== undefined) {
    const salaries = (model.sources ?? [])
      .filter((s) => s.enabled && s.type === 'salary')
      .sort((a, b) => (b.details.annualAmount ?? 0) - (a.details.annualAmount ?? 0));

    if (salaries.length > 0) {
      const target = salaries[0];
      const endDate = addMonths(model.horizon?.startDate ?? target.startDate, k.monthsUntilLoss);
      overrides.push(makeOverride(target.id, 'endDate', endDate, {
        note: `${spec.label} preset: ${target.name} ends on ${endDate}`,
      }));
    }
  }

  return overrides;
}

/** A whole scenario from a preset, ready to be added to the model. */
export function buildPresetScenario(model, preset, knobs = {}) {
  const spec = PRESETS[preset];
  return makeScenario({
    id: `preset-${preset}`,
    name: spec.label,
    description: spec.description,
    overrides: buildPresetOverrides(model, preset, knobs),
    presetOrigin: { preset, knobs: { ...spec.knobs, ...knobs }, generatedAt: null },
  });
}

