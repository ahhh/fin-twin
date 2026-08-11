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
import { addMonths, isOnOrAfter, isOnOrBefore } from './dates.js';

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

  /* ---- life events ---- */

  newChild: {
    label: 'A child arrives',
    description: 'Unpaid leave, then childcare and the running costs of a third person.',
    knobs: {
      monthsUntilBirth: 9,
      birthCost: 3_000_00,
      unpaidLeaveMonths: 3,
      childcareMonthly: 1_400_00,
      childcareYears: 5,
      childCostsMonthly: 350_00,
    },
  },
  startingFamily: {
    label: 'Starting a family',
    description: 'A child, and the second income dropping to part-time for the years that follow.',
    knobs: {
      monthsUntilBirth: 9,
      birthCost: 3_000_00,
      unpaidLeaveMonths: 3,
      childcareMonthly: 1_400_00,
      childcareYears: 5,
      childCostsMonthly: 350_00,
      partTimeFactor: 0.6,
    },
  },
  mortgage: {
    label: 'Buy a house',
    description: 'A deposit, a mortgage, and the costs of owning rather than renting.',
    knobs: {
      monthsUntilPurchase: 6,
      purchasePrice: 450_000_00,
      depositRate: 0.20,
      closingCostRate: 0.03,
      annualRate: 0.065,
      termMonths: 360,
      // Rules of thumb, and all three are knobs precisely because they are guesses.
      propertyTaxRate: 0.012,
      insuranceAnnual: 1_800_00,
      maintenanceRate: 0.01,
    },
  },
  seriousIllness: {
    label: 'Serious illness',
    description: 'Work stops for a while, sick pay replaces part of it, and the medical bills land.',
    knobs: {
      monthsUntilIllness: 3,
      monthsOffWork: 6,
      sickPayRate: 0.6,
      outOfPocketMax: 9_000_00,
      ongoingMedicalMonthly: 400_00,
    },
  },
});

/** Which presets add items to the plan rather than only adjusting the ones already in it. */
export const LIFE_EVENT_PRESETS = Object.freeze(['newChild', 'startingFamily', 'mortgage', 'seriousIllness']);

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
  const isIncome = (source) => getSourceType(source.type).family === 'income';

  for (const source of model.sources ?? []) {
    if (!source.enabled) continue;

    /* growth rates */
    // Any income source that grows, not salaries alone. A rent escalator and a contract
    // rate rise are the same assumption as a pay rise, and a Conservative scenario that
    // silently left them at full speed would be the invisible-multiplier failure this
    // file exists to avoid — just in the other direction.
    if (k.incomeGrowthFactor !== undefined && isIncome(source)
        && canOverride(source, 'details.growthRate') && source.details.growthRate) {
      overrides.push(makeOverride(source.id, 'details.growthRate', k.incomeGrowthFactor, {
        op: 'scale',
        note: `${spec.label} preset: ${source.name} rises scaled to ${Math.round(k.incomeGrowthFactor * 100)}%`,
      }));
    }

    // Investment yield is the same knob wearing a different name.
    if (k.incomeGrowthFactor !== undefined && canOverride(source, 'details.yieldRate')
        && source.details.yieldRate) {
      overrides.push(makeOverride(source.id, 'details.yieldRate', k.incomeGrowthFactor, {
        op: 'scale',
        note: `${spec.label} preset: ${source.name} yield scaled to ${Math.round(k.incomeGrowthFactor * 100)}%`,
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

  /* life events — see the section below for why these add sources as well */
  if (preset === 'newChild' || preset === 'startingFamily') {
    overrides.push(...unpaidLeave(model, preset, k).overrides);
  }
  if (preset === 'startingFamily' && k.partTimeFactor !== undefined) {
    // The SECOND income, not the largest: the household keeps its main earner and the
    // other one goes part-time, which is the usual shape and the one worth modelling.
    const second = salariesBySize(model)[1];
    if (second) {
      overrides.push(makeOverride(second.id, 'details.annualAmount', k.partTimeFactor, {
        op: 'scale',
        note: `${spec.label}: ${second.name} drops to ${Math.round(k.partTimeFactor * 100)}% — part-time`,
      }));
    }
  }
  if (preset === 'mortgage') {
    overrides.push(...endTheRent(model, preset, mortgageSources(model, preset, k).buyOn));
  }
  if (preset === 'seriousIllness') {
    overrides.push(...illness(model, preset, k).overrides);
  }

  /* job loss targets the largest salary being paid on the day it happens */
  if (k.monthsUntilLoss !== undefined) {
    const endDate = addMonths(startOf(model), k.monthsUntilLoss);
    // Not simply the largest salary: ending a job that has not started yet makes the
    // compiler drop it, so "job loss" would leave the household better off than the base
    // plan. You can only lose a job you currently have.
    const target = salaryActiveOn(model, endDate);

    if (target) {
      overrides.push(makeOverride(target.id, 'endDate', endDate, {
        note: `${spec.label} preset: ${target.name} ends on ${endDate}`,
      }));
    }
  }

  return overrides;
}

/* ---- life events ---- */

/**
 * Life-event presets add items rather than only adjusting the ones already there, because
 * a child and a mortgage are new facts about a plan, not new assumptions about it.
 *
 * They are added as ORDINARY SOURCES — same shape, same editor, same charts, listed
 * alongside everything else with a note saying where they came from. The alternative, a
 * preset that knew how to make cash disappear, would be exactly the unauditable magic
 * this file exists to avoid. Every figure below is a knob, and every knob is a guess the
 * user is meant to argue with.
 */

const startOf = (model) => model.horizon?.startDate ?? model.sources?.[0]?.startDate ?? '2026-01-01';

/** Enabled sources of a family, largest first by whatever field names their size. */
function biggestFirst(model, family, sizeOf) {
  return (model.sources ?? [])
    .filter((s) => s.enabled && getSourceType(s.type).family === family)
    .sort((a, b) => (sizeOf(b) ?? 0) - (sizeOf(a) ?? 0));
}

const salariesBySize = (model) =>
  (model.sources ?? [])
    .filter((s) => s.enabled && s.type === 'salary')
    .sort((a, b) => (b.details.annualAmount ?? 0) - (a.details.annualAmount ?? 0));

/**
 * The largest salary actually being paid on a given date.
 *
 * Interrupting a job that has not started yet is not a smaller income, it is a larger one:
 * ending it on a date before it begins makes the compiler drop the source entirely, so the
 * "reduced" scenario quietly pays more than the base plan. Asking who is actually being
 * paid that day is the whole fix.
 */
const salaryActiveOn = (model, iso) =>
  salariesBySize(model).find((s) =>
    isOnOrBefore(s.startDate, iso) && (!s.endDate || isOnOrAfter(s.endDate, iso)));

/** A well-formed source of `type`, built from its own defaults so it cannot drift. */
function addedSource(preset, key, type, { name, startDate, endDate = null, personId = null, details = {} }) {
  const base = getSourceType(type).defaults();
  return {
    ...base,
    id: `preset-${preset}-${key}`,
    name,
    enabled: true,
    personId,
    startDate,
    endDate,
    details: { ...base.details, ...details },
    notes: `Added by the "${PRESETS[preset].label}" scenario. Edit or delete it like anything else.`,
  };
}

/** The direct costs of a child: the birth, the leave, the childcare, the rest. */
function childSources(model, preset, k) {
  const born = addMonths(startOf(model), k.monthsUntilBirth ?? 9);
  const add = (key, type, spec) => addedSource(preset, key, type, spec);
  const sources = [];

  if (k.birthCost > 0) {
    sources.push(add('birth', 'expense', {
      name: 'Birth — out of pocket', startDate: born, endDate: born,
      details: {
        amount: k.birthCost, frequency: 'once', category: 'healthcare',
        essential: true, cutPriority: 1, inflationRate: 0,
      },
    }));
  }

  if (k.childcareMonthly > 0 && k.childcareYears > 0) {
    // Childcare starts when the leave ends, not at birth — paying a nursery while a
    // parent is at home is a cost most plans do not actually incur.
    const from = addMonths(born, k.unpaidLeaveMonths ?? 0);
    sources.push(add('childcare', 'expense', {
      name: 'Childcare', startDate: from, endDate: addMonths(born, 12 * k.childcareYears),
      details: {
        amount: k.childcareMonthly, frequency: 'monthly', category: 'childcare',
        essential: true, cutPriority: 1,
      },
    }));
  }

  if (k.childCostsMonthly > 0) {
    sources.push(add('childcosts', 'expense', {
      name: 'Child — food, clothes, everything else', startDate: born,
      details: {
        amount: k.childCostsMonthly, frequency: 'monthly', category: 'general',
        essential: true, cutPriority: 2,
      },
    }));
  }

  return sources;
}

/**
 * Unpaid leave, modelled by ending the salary and starting it again afterwards.
 *
 * The obvious shortcut — an expense the size of the missing pay — would be wrong in a way
 * that matters: an expense reduces cash but not taxable income, so it would invent a tax
 * bill on money never earned. Stopping and restarting the salary is what actually happens,
 * and the tax engine then gets it right for free.
 */
function unpaidLeave(model, preset, k) {
  const months = k.unpaidLeaveMonths ?? 0;
  const born = addMonths(startOf(model), k.monthsUntilBirth ?? 9);
  const salary = salaryActiveOn(model, born);
  if (months <= 0 || !salary) return { overrides: [], sources: [] };

  const backAt = addMonths(born, months);
  const label = PRESETS[preset].label;

  return {
    overrides: [makeOverride(salary.id, 'endDate', born, {
      note: `${label}: ${salary.name} pauses for ${months} months of unpaid leave`,
    })],
    sources: resumeWork(salary, {
      preset, startDate: backAt, suffix: 'back from leave',
      why: 'the same job resuming after unpaid leave',
    }),
  };
}

/**
 * The source that puts someone back on the payroll after a break.
 *
 * Returns nothing if the job would have ended during the break anyway — a fixed-term
 * contract that expires while you are on leave does not resume, and adding it back would
 * invent income out of the scenario's own machinery.
 */
function resumeWork(salary, { preset, startDate, suffix, why, details = {} }) {
  if (salary.endDate && isOnOrBefore(salary.endDate, startDate)) return [];
  return [{
    ...structuredClone(salary),
    id: `preset-${preset}-${suffix.replace(/[^a-z]/gi, '')}`,
    name: `${salary.name} (${suffix})`,
    startDate,
    endDate: salary.endDate,
    details: { ...salary.details, ...details },
    notes: `Added by the "${PRESETS[preset].label}" scenario: ${why}.`,
  }];
}

function mortgageSources(model, preset, k) {
  const buyOn = addMonths(startOf(model), k.monthsUntilPurchase ?? 6);
  const deposit = Math.round(k.purchasePrice * k.depositRate);
  const closing = Math.round(k.purchasePrice * k.closingCostRate);
  const borrowed = k.purchasePrice - deposit;
  const add = (key, type, spec) => addedSource(preset, key, type, spec);

  const sources = [
    add('deposit', 'expense', {
      name: 'Deposit and closing costs', startDate: buyOn, endDate: buyOn,
      details: {
        amount: deposit + closing, frequency: 'once', category: 'housing',
        essential: true, cutPriority: 1, inflationRate: 0,
      },
    }),
    add('mortgage', 'loan', {
      name: 'Mortgage', startDate: addMonths(buyOn, 1),
      details: {
        principal: borrowed, annualRate: k.annualRate, termMonths: k.termMonths,
        deductibleInterest: true,
      },
    }),
    add('propertytax', 'expense', {
      name: 'Property tax', startDate: buyOn,
      details: {
        amount: Math.round((k.purchasePrice * k.propertyTaxRate) / 12), frequency: 'monthly',
        category: 'property', essential: true, cutPriority: 1,
      },
    }),
    add('homeinsurance', 'expense', {
      name: 'Home insurance', startDate: buyOn,
      details: {
        amount: Math.round(k.insuranceAnnual / 12), frequency: 'monthly',
        category: 'insurance', essential: true, cutPriority: 1,
      },
    }),
    // The line everyone leaves out. A roof and a boiler are not optional, they are just
    // infrequent, which is precisely what makes them easy to plan as though they were free.
    add('maintenance', 'expense', {
      name: 'Maintenance and repairs', startDate: buyOn,
      details: {
        amount: Math.round((k.purchasePrice * k.maintenanceRate) / 12), frequency: 'monthly',
        category: 'property', essential: false, cutPriority: 3,
      },
    }),
  ];

  return { sources, buyOn };
}

/** Buying usually means no longer renting; leaving both in would flatter nothing. */
function endTheRent(model, preset, buyOn) {
  const rents = biggestFirst(model, 'expense', (s) => s.details?.amount)
    .filter((s) => s.details?.category === 'housing' && s.details?.frequency === 'monthly');

  if (rents.length === 0) return [];
  return [makeOverride(rents[0].id, 'endDate', buyOn, {
    note: `${PRESETS[preset].label}: ${rents[0].name} stops when the house completes`,
  })];
}

function illness(model, preset, k) {
  const startsOn = addMonths(startOf(model), k.monthsUntilIllness ?? 3);
  const backAt = addMonths(startsOn, k.monthsOffWork ?? 6);
  const label = PRESETS[preset].label;
  const add = (key, type, spec) => addedSource(preset, key, type, spec);

  const sources = [
    add('oopmax', 'expense', {
      name: 'Medical — out-of-pocket maximum', startDate: startsOn, endDate: startsOn,
      details: {
        amount: k.outOfPocketMax, frequency: 'once', category: 'healthcare',
        essential: true, cutPriority: 1, inflationRate: 0,
      },
    }),
    add('ongoing', 'expense', {
      name: 'Ongoing medical costs', startDate: startsOn,
      details: {
        amount: k.ongoingMedicalMonthly, frequency: 'monthly', category: 'healthcare',
        essential: true, cutPriority: 1,
      },
    }),
  ];

  const overrides = [];
  const salary = salaryActiveOn(model, startsOn);

  // No job on the day it starts means no income to interrupt. The medical costs still
  // land — that is the part of an illness that does not care whether you were working.
  if (salary) {
    overrides.push(makeOverride(salary.id, 'endDate', startsOn, {
      note: `${label}: ${salary.name} stops for ${k.monthsOffWork} months`,
    }));

    // Sick pay is a real, taxed, reduced wage — so it is a salary, not a discount applied
    // to the old one. Modelling it as a scaled version of the original would keep paying
    // the pre-tax retirement contribution out of pay that no longer exists.
    if (k.sickPayRate > 0) {
      sources.push({
        ...structuredClone(salary),
        id: `preset-${preset}-sickpay`,
        name: `${salary.name} — sick pay`,
        startDate: startsOn,
        endDate: backAt,
        details: {
          ...salary.details,
          annualAmount: Math.round((salary.details.annualAmount ?? 0) * k.sickPayRate),
          preTaxRate: 0,
        },
        notes: `Added by the "${label}" scenario: ${Math.round(k.sickPayRate * 100)}% of normal pay while off work.`,
      });
    }

    sources.push(...resumeWork(salary, {
      preset, startDate: backAt, suffix: 'back to work',
      why: 'the same job resuming after recovery',
    }));
  }

  return { sources, overrides };
}

/**
 * The sources a preset adds to the plan.
 *
 * @returns {Array} whole sources, each carrying a note saying which scenario added it
 */
export function buildPresetSources(model, preset, knobs = {}) {
  const spec = PRESETS[preset];
  if (!spec) throw new Error(`unknown preset "${preset}"`);
  const k = { ...spec.knobs, ...knobs };

  switch (preset) {
    case 'newChild':
    case 'startingFamily':
      return [...childSources(model, preset, k), ...unpaidLeave(model, preset, k).sources];
    case 'mortgage':
      return mortgageSources(model, preset, k).sources;
    case 'seriousIllness':
      return illness(model, preset, k).sources;
    default:
      return [];
  }
}

/** A whole scenario from a preset, ready to be added to the model. */
export function buildPresetScenario(model, preset, knobs = {}) {
  const spec = PRESETS[preset];
  return makeScenario({
    id: `preset-${preset}`,
    name: spec.label,
    description: spec.description,
    overrides: buildPresetOverrides(model, preset, knobs),
    addedSources: buildPresetSources(model, preset, knobs),
    presetOrigin: { preset, knobs: { ...spec.knobs, ...knobs }, generatedAt: null },
  });
}

