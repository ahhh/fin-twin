/**
 * The warning catalogue.
 *
 * Central principle: **the engine reports, it does not repair.** When user data is
 * suspect, we emit a warning and carry on with the numbers exactly as entered. Silently
 * "fixing" an overlapping salary or a negative expense produces a projection the user
 * cannot reconcile with what they typed, which is worse than a wrong number they can see.
 *
 * Every code emitted anywhere must appear here (asserted by tests), so no warning can
 * reach the UI without a human-readable message and a severity.
 */

export const SEVERITIES = Object.freeze(['info', 'warn', 'error']);

/**
 * code -> {severity, title, explain(data) -> string}
 *
 * `explain` receives the warning's `data` and returns one sentence in plain language.
 * Keep it specific — "Rent overlaps by 3 months" beats "overlapping sources detected".
 */
export const WARNING_CATALOGUE = Object.freeze({
  /* ---- horizon ---- */
  'horizon.event_dropped': {
    severity: 'warn',
    title: 'Payment falls outside the projection',
    explain: (d) =>
      `${d.label ?? 'A payment'} settles on ${d.date}, which is outside the projection ` +
      `(${d.horizonStart} to ${d.horizonEnd}), so it is not counted. ` +
      'Extend the horizon if you want to see it.',
  },

  /* ---- source data integrity ---- */
  'source.end_before_start': {
    severity: 'error',
    title: 'End date is before the start date',
    explain: (d) => `"${d.name}" ends on ${d.endDate}, before it starts on ${d.startDate}.`,
  },
  'source.negative_amount': {
    severity: 'warn',
    title: 'Negative amount',
    explain: (d) =>
      `"${d.name}" has a negative amount (${d.field}). Amounts are entered as positives; ` +
      'the model applies the sign. A negative here may double-negate.',
  },
  'source.zero_amount': {
    severity: 'info',
    title: 'Amount is zero',
    explain: (d) => `"${d.name}" is enabled but its amount is zero, so it produces nothing.`,
  },
  'source.starts_after_horizon': {
    severity: 'info',
    title: 'Starts after the projection ends',
    explain: (d) => `"${d.name}" starts on ${d.startDate}, after the projection ends on ${d.horizonEnd}.`,
  },
  'source.overlapping_salaries': {
    severity: 'warn',
    title: 'Two jobs overlap',
    explain: (d) =>
      `"${d.a}" and "${d.b}" both pay ${d.person} between ${d.from} and ${d.to}. ` +
      'If one replaced the other, set an end date on the first.',
  },
  'source.withholding_exceeds_gross': {
    severity: 'error',
    title: 'Withholding is larger than the pay',
    explain: (d) =>
      `"${d.name}" withholds more than it pays (${d.withholdingPct}% of gross plus deductions). ` +
      'Net pay would be negative.',
  },
  'source.unknown_type': {
    severity: 'error',
    title: 'Unknown item type',
    explain: (d) => `"${d.name ?? d.sourceId}" has type "${d.type}", which this version does not know how to model.`,
  },

  'loan.never_amortises': {
    severity: 'error',
    title: 'This loan never gets paid off',
    explain: (d) =>
      `The payment on "${d.name ?? 'this loan'}" (${d.payment}) does not cover the monthly ` +
      `interest (${d.interest}), so the balance grows instead of shrinking.`,
  },
  'asset.sale_without_proceeds': {
    severity: 'warn',
    title: 'Sale has no price',
    explain: (d) => `"${d.name}" has a sale date but no sale price, so the sale is ignored.`,
  },
  'asset.no_cost_basis': {
    severity: 'warn',
    title: 'No purchase price recorded',
    explain: (d) =>
      `"${d.name}" is being sold but has no purchase price, so the whole sale price counts ` +
      'as a gain. That almost certainly overstates the tax.',
  },

  /* ---- sinking funds ---- */
  'sinking.autocover': {
    severity: 'warn',
    title: 'Sinking fund did not cover the bill',
    explain: (d) =>
      `The ${d.fund} reserve was short by ${d.shortfall} when ${d.label} came due on ${d.date}, ` +
      'so the difference was taken from cash.',
  },
  'sinking.underfunded_at_due': {
    severity: 'warn',
    title: 'Reserve will not reach the target in time',
    explain: (d) => `Saving ${d.perMonth} a month will not reach ${d.target} by ${d.dueDate}.`,
  },

  /* ---- cash ---- */
  'cash.below_zero': {
    severity: 'error',
    title: 'Cash goes negative',
    explain: (d) => `Projected cash falls to ${d.amount} in ${d.period}.`,
  },
  'cash.below_emergency_target': {
    severity: 'warn',
    title: 'Cash falls below the emergency target',
    explain: (d) => `Liquid cash drops below the ${d.months}-month target in ${d.period}.`,
  },

  /* ---- scenarios ---- */
  'scenario.dangling_source': {
    severity: 'error',
    title: 'Override points at a deleted item',
    explain: (d) =>
      `An override targets "${d.sourceId}", which no longer exists. ` +
      'This scenario is incomplete — the change you expected is not being applied.',
  },
  'scenario.unknown_path': {
    severity: 'error',
    title: 'Override targets an unknown field',
    explain: (d) =>
      `"${d.path}" is not an overridable field on a ${d.type}. The override was skipped, ` +
      'so this scenario is showing base numbers for that item.',
  },
  'scenario.type_mismatch': {
    severity: 'error',
    title: 'Override value has the wrong type',
    explain: (d) => `"${d.path}" expects ${d.expected}, but the override supplies ${d.got}. It was skipped.`,
  },
  'scenario.shadowed_override': {
    severity: 'info',
    title: 'Override replaced by a later one',
    explain: (d) => `Two overrides target "${d.path}" on the same item; only the last one applies.`,
  },

  /* ---- tax ---- */
  'tax.no_rule_pack': {
    severity: 'warn',
    title: 'No tax rules for this year',
    explain: (d) =>
      `There is no tax rule pack for ${d.year}, so ${d.usedYear} rules were carried forward. ` +
      'Those figures are extrapolated, not the published amounts.',
  },
  'tax.no_prior_year_liability': {
    severity: 'info',
    title: 'No prior-year tax on file',
    explain: () =>
      'Safe-harbour needs last year\'s tax. Without it, the estimate uses 90% of this ' +
      'year\'s projected tax instead.',
  },
  'tax.se_below_minimum': {
    severity: 'info',
    title: 'Self-employment tax not due',
    explain: (d) => `Net self-employment earnings of ${d.netEarnings} are below the threshold, so no SE tax applies.`,
  },
  'tax.multiple_w2_ss_overwithholding': {
    severity: 'info',
    title: 'Social Security over-withheld across two jobs',
    explain: (d) =>
      `${d.person} has two jobs whose combined pay exceeds the Social Security wage base. ` +
      'Each employer withholds up to the base separately, so the excess comes back as a credit.',
  },
  'tax.preferential_not_modeled': {
    severity: 'warn',
    title: 'Capital gains not modelled',
    explain: () =>
      'This version taxes all income at ordinary rates. Long-term gains and qualified ' +
      'dividends would be taxed lower, so the estimate is high.',
  },
  'tax.contribution_over_limit': {
    severity: 'warn',
    title: 'Contribution is above the annual limit',
    explain: (d) => `${d.plan} contributions total ${d.total} in ${d.year}, above the ${d.limit} limit.`,
  },

  'qbi.sstb_phasing_out': {
    severity: 'info',
    title: 'Business deduction is phasing out',
    explain: (d) =>
      `Income is inside the phase-out range for a specified service business, so only ` +
      `${d.remaining}% of the qualified business income deduction applies.`,
  },
  'qbi.sstb_phased_out': {
    severity: 'info',
    title: 'No business deduction at this income',
    explain: () =>
      'A specified service business — consulting, law, health, accounting and similar — ' +
      'gets no qualified business income deduction above the phase-out range.',
  },
  'qbi.above_threshold_unlimited': {
    severity: 'warn',
    title: 'Business deduction may be overstated',
    explain: () =>
      'Above the income threshold, the qualified business income deduction is capped by ' +
      'the wages you pay and the property you hold, which this version does not model. ' +
      'The deduction shown may be too generous. Worth checking with a tax professional.',
  },

  'tax.state_pack_unverified': {
    severity: 'warn',
    title: 'State tax figures are unverified',
    explain: (d) =>
      `The ${d.state} rules for ${d.year} in this build have not been checked against an ` +
      'official publication. Treat any state tax figure here as a rough indication only.',
  },

  /* ---- engine ---- */
  'engine.close_rule_taxable': {
    severity: 'error',
    title: 'A close rule changed taxable income',
    explain: (d) =>
      `The "${d.rule}" close rule emitted taxable income, which the two-pass engine cannot ` +
      'account for. See the note on maxIterations in engine.js.',
  },
});

export class WarningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WarningError';
    this.code = code;
  }
}

/**
 * Build a warning. Throws if the code is not catalogued — a warning with no message is a
 * warning the user cannot act on.
 */
export function makeWarning(code, data = {}, sourceId = null) {
  const entry = WARNING_CATALOGUE[code];
  if (!entry) {
    throw new WarningError(
      'warning.uncatalogued',
      `warning code "${code}" is not in WARNING_CATALOGUE (model/warnings.js). ` +
        'Add it with a severity and a plain-language explanation before emitting it.',
    );
  }

  let message;
  try {
    message = entry.explain(data);
  } catch (err) {
    message = `${entry.title} (details unavailable: ${err.message})`;
  }

  return Object.freeze({
    code,
    severity: entry.severity,
    title: entry.title,
    message,
    sourceId,
    data: Object.freeze({ ...data }),
  });
}

export const isCatalogued = (code) => Object.hasOwn(WARNING_CATALOGUE, code);
export const ALL_WARNING_CODES = Object.freeze(Object.keys(WARNING_CATALOGUE).sort());

/** Sort worst-first, then by code, so the panel is stable between runs. */
export function sortWarnings(warnings) {
  const rank = { error: 0, warn: 1, info: 2 };
  return [...warnings].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code),
  );
}

export function countBySeverity(warnings) {
  const out = { error: 0, warn: 0, info: 0 };
  for (const w of warnings) out[w.severity] += 1;
  return out;
}
