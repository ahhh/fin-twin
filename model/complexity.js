/**
 * Simple mode, and what "advanced" adds.
 *
 * The whole point of this app is irregular income and tax reality — which is exactly the
 * material that makes a first screen unusable. So the default is a plan you can build from
 * five inputs, and everything else is opt-in.
 *
 * This is the ONE place the split is defined. Views, the nav, the source picker and the
 * KPI row all ask here rather than each carrying their own idea of what counts as
 * advanced — otherwise the levels drift apart and something ends up half-hidden.
 *
 * The design rule: simple mode is not a crippled version, it is a STAGED one. Nothing is
 * removed that the user has already got; advanced features surface at the moment they
 * become relevant (see `advancedPrompts`), rather than sitting in the way beforehand.
 */

export const LEVELS = Object.freeze(['simple', 'advanced']);
export const DEFAULT_LEVEL = 'simple';

export const isAdvanced = (model) => (model?.complexity ?? DEFAULT_LEVEL) === 'advanced';
export const levelOf = (model) => (isAdvanced(model) ? 'advanced' : 'simple');

/**
 * Which sections of the app exist at each level.
 *
 * Taxes, Scenarios and Assumptions are hidden in simple mode. A salaried person with a
 * withholding percentage does not need a tax view, and scenarios are meaningless until
 * there is something uncertain to vary.
 */
export const VIEW_LEVELS = Object.freeze({
  dashboard: 'simple',
  income: 'simple',
  expenses: 'simple',
  taxes: 'advanced',
  scenarios: 'advanced',
  assumptions: 'advanced',
});

export const viewsFor = (model) =>
  Object.keys(VIEW_LEVELS).filter((view) => allows(model, VIEW_LEVELS[view]));

export const viewAllowed = (model, view) => allows(model, VIEW_LEVELS[view] ?? 'advanced');

/** True when `level` is available under the model's setting. */
export function allows(model, level) {
  return level === 'simple' || isAdvanced(model);
}

/**
 * Dashboard panels, by level.
 *
 * Simple mode gets the two questions people actually open the app with — how much have I
 * got, and where is it going. The composition chart and the won/lost strip are answers to
 * questions a simple plan cannot yet ask.
 */
export const PANEL_LEVELS = Object.freeze({
  kpis: 'simple',
  cashChart: 'simple',
  timelineChart: 'simple',
  upcoming: 'simple',
  warnings: 'simple',
  uncertaintyStrip: 'advanced',
  incomeComposition: 'advanced',
});

export const panelAllowed = (model, panel) => allows(model, PANEL_LEVELS[panel] ?? 'advanced');

/**
 * KPI tiles, by level.
 *
 * Six tiles is too many to read. Simple mode shows four, and the two that are hidden —
 * spendable-after-tax and income concentration — are meaningless without untaxed or
 * multiple income sources anyway.
 */
export const KPI_LEVELS = Object.freeze({
  liquidCash: 'simple',
  minimumCash: 'simple',
  emergencyMonths: 'simple',
  monthlySurplus: 'simple',
  spendableCash: 'advanced',
  variableIncomeShare: 'advanced',
  incomeConcentration: 'advanced',
});

export const kpiAllowed = (model, kpi) => allows(model, KPI_LEVELS[kpi] ?? 'advanced');

/* -------------------------------------------------------------------------- */
/* Staging: when to offer the next step                                        */
/* -------------------------------------------------------------------------- */

/**
 * Reasons this particular model has outgrown simple mode.
 *
 * Checked against what the user has actually built, so the prompt arrives when it is
 * useful rather than as a permanent advert. Each returns a sentence in the user's terms —
 * "you have income that is not taxed at source", not "enable advanced features".
 */
export function advancedPrompts(model, run = null) {
  if (isAdvanced(model)) return [];
  const prompts = [];

  const types = new Set((model.sources ?? []).filter((s) => s.enabled).map((s) => s.type));

  if ([...types].some((type) => UNWITHHELD_INCOME_TYPES.has(type))) {
    prompts.push({
      id: 'untaxed-income',
      message: 'You have income that is not taxed at source. Advanced mode estimates what ' +
        'you will owe and how much to set aside.',
    });
  }
  if (types.has('loan') || types.has('asset')) {
    prompts.push({
      id: 'balance-sheet',
      message: 'You have a loan or an investment. Advanced mode tracks what you own and ' +
        'owe over time, not just the cash.',
    });
  }
  if ((model.sources ?? []).some((s) => s.enabled && s.certainty?.mode === 'probability')) {
    prompts.push({
      id: 'uncertainty',
      message: 'Something in your plan might not happen. Advanced mode shows what follows ' +
        'if it does and if it does not, side by side.',
    });
  }
  if ((model.scenarios ?? []).length > 0) {
    prompts.push({
      id: 'scenarios',
      message: 'This plan has scenarios saved. Advanced mode is where you compare them.',
    });
  }

  const incomeSources = (model.sources ?? []).filter((s) => s.enabled && isIncomeType(s.type));
  if (incomeSources.length >= 3) {
    prompts.push({
      id: 'concentration',
      message: 'You have several income sources. Advanced mode shows how much of your plan ' +
        'rests on any one of them.',
    });
  }

  if (run && (run.metrics?.taxReserveGap?.value ?? 0) > 0) {
    prompts.push({
      id: 'tax-gap',
      message: 'Your plan has tax that is not covered by withholding. Advanced mode shows ' +
        'how much and when it is due.',
    });
  }

  return prompts;
}

/**
 * Income types with no withholding, so the tax arrives as a bill rather than a deduction.
 *
 * Not derived from the registry on purpose: this module imports nothing, so the level
 * split can be asked about before any source module has loaded. The cost is that a new
 * unwithheld income type has to be added here too, which `tests/complexity.test.js`
 * checks for.
 */
const UNWITHHELD_INCOME_TYPES = new Set([
  'contract', 'royalty', 'fixed_contract', 'investment_income',
]);

const INCOME_TYPES = new Set([
  'salary', 'contract', 'royalty', 'fixed_contract', 'windfall', 'investment_income',
]);
const isIncomeType = (type) => INCOME_TYPES.has(type);

/**
 * Source types in a model that simple mode cannot fully represent.
 *
 * Used to warn rather than to hide: an imported plan keeps everything it came with, and is
 * told plainly that some of it is not on screen. Silently dropping a mortgage from view
 * would be far worse than showing a banner.
 */
export function unsupportedInSimple(model, typeComplexity) {
  if (isAdvanced(model)) return [];
  return [...new Set(
    (model.sources ?? [])
      .filter((s) => s.enabled && typeComplexity(s.type) === 'advanced')
      .map((s) => s.type),
  )].sort();
}
