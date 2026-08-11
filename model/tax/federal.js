/**
 * The federal income tax estimate.
 *
 * Reads a taxable book — {personId: {category: cents}} — and a rule pack, and returns a
 * year's result. Owns no constants; every figure comes from the pack.
 *
 * THE DOUBLE-COUNT TRAP, stated loudly because it is the easiest bug to write here:
 * pre-tax deferrals have ALREADY reduced taxable income. They arrive as negative
 * `pretax_deferral` amounts booked on the paycheck legs, so they belong in gross income,
 * NOT in the above-the-line adjustments. Subtracting them a second time understates the
 * tax by roughly a marginal rate on the whole deferral, and the result still looks
 * perfectly reasonable. `assertNoDoubleCount` below is what stops that.
 */

import { atLeastZero, scaleCents, sumCents } from '../money.js';
import { bracketTax, preferentialTax, statutoryBracketRate } from './rule-pack.js';
import {
  computeAdditionalMedicare, computeFica, computeSelfEmployment,
} from './payroll.js';
import { computeQbi, qbiFromBook } from './qbi.js';

export class FederalTaxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FederalTaxError';
    this.code = code;
  }
}

/** Which bucket each taxable category feeds. Adding a category means adding a line here. */
export const CATEGORY_BUCKETS = Object.freeze({
  w2_wages: 'wages',
  se_net_profit: 'selfEmployment',
  interest: 'ordinary',
  ordinary_dividends: 'ordinary',
  other_ordinary: 'ordinary',
  rental_net: 'ordinary',
  retirement_distribution_ordinary: 'ordinary',
  short_term_gains: 'ordinary',
  qualified_dividends: 'preferential',
  long_term_gains: 'preferential',
  tax_exempt_interest: 'exempt',
  pretax_deferral: 'deferral',
  above_line_deduction: 'aboveLine',
});

/** The amount used to probe the marginal rate: one dollar. */
const PROBE_CENTS = 100;

function bucketise(personBook) {
  const totals = { wages: 0, selfEmployment: 0, ordinary: 0, preferential: 0, exempt: 0, deferral: 0, aboveLine: 0 };
  for (const [category, cents] of Object.entries(personBook)) {
    const bucket = CATEGORY_BUCKETS[category];
    if (!bucket) {
      throw new FederalTaxError('tax.unmapped_category',
        `taxable category "${category}" has no bucket in CATEGORY_BUCKETS`);
    }
    totals[bucket] += cents;
  }
  return totals;
}

function assertNoDoubleCount(totals, personId) {
  if (totals.deferral > 0) {
    throw new FederalTaxError('tax.deferral_sign',
      `pre-tax deferrals for ${personId} total ${totals.deferral}, which is positive. ` +
      'They must be negative: they reduce taxable income at the paycheck.');
  }
  if (totals.aboveLine > 0) {
    throw new FederalTaxError('tax.above_line_sign',
      `above-the-line adjustments for ${personId} total ${totals.aboveLine}, which is positive. ` +
      'They must be negative.');
  }
}

/**
 * @param {Object} yearBook   {personId: {category: cents}} for one tax year
 * @param {Object} household  {filingStatus, people}
 * @param {Object} pack
 * @param {Object} [options]
 * @param {number} [options.itemizedDeduction]
 * @param {number} [options.credits]
 * @returns {Object} a year result
 */
export function computeFederal(yearBook, household, pack, options = {}) {
  const { filingStatus } = household;
  const brackets = pack.ordinaryBrackets[filingStatus];
  if (!brackets) {
    throw new FederalTaxError('tax.unknown_filing_status',
      `rule pack ${pack.packId} has no brackets for filing status "${filingStatus}"`);
  }

  const warnings = [];
  const perPerson = {};

  let grossIncome = 0;
  let deferrals = 0;
  let aboveLineEntered = 0;
  let preferential = 0;
  let exempt = 0;
  let seTaxTotal = 0;
  let seDeductible = 0;
  let ficaTotal = 0;
  let additionalMedicareBase = 0;

  for (const [personId, personBook] of Object.entries(yearBook)) {
    const totals = bucketise(personBook);
    assertNoDoubleCount(totals, personId);

    // Per person, because the Social Security wage base is per person.
    const fica = computeFica(totals.wages, pack);
    const se = computeSelfEmployment(totals.selfEmployment, totals.wages, pack);

    if (se.belowMinimum && totals.selfEmployment > 0) {
      warnings.push({ code: 'tax.se_below_minimum', data: { netEarnings: se.netEarnings, personId } });
    }

    grossIncome += totals.wages + totals.selfEmployment + totals.ordinary + totals.preferential;
    deferrals += totals.deferral;
    aboveLineEntered += totals.aboveLine;
    preferential += totals.preferential;
    exempt += totals.exempt;
    seTaxTotal += se.total;
    seDeductible += se.deductibleHalf;
    ficaTotal += fica.total;

    // Additional Medicare applies to the household's combined wages + SE net earnings.
    additionalMedicareBase += totals.wages + se.netEarnings;

    perPerson[personId] = { ...totals, fica, selfEmploymentTax: se };
  }

  const additionalMedicare = computeAdditionalMedicare(additionalMedicareBase, filingStatus, pack);

  // Deferrals are folded into gross income (they are already negative). They are NOT
  // above-the-line adjustments — see the note at the top of this file.
  const aboveTheLine = seDeductible - aboveLineEntered;
  const agi = grossIncome + deferrals - aboveTheLine;

  const standard = pack.standardDeduction[filingStatus];
  const itemized = options.itemizedDeduction ?? 0;
  const deduction = Math.max(standard, itemized);
  const usedItemized = itemized > standard;

  const taxableIncomeBeforeQbi = atLeastZero(agi - deduction);

  /* The QBI deduction comes off taxable income, but is itself limited BY taxable income —
   * so it has to be computed from the pre-QBI figure and then subtracted. */
  const qbiInput = Object.entries(perPerson).reduce(
    (sum, [, totals]) => sum + qbiFromBook(totals, totals.selfEmploymentTax?.deductibleHalf ?? 0),
    0,
  );
  const qbiResult = computeQbi({
    qbi: options.qbiOverride ?? qbiInput,
    taxableIncome: taxableIncomeBeforeQbi,
    netCapitalGain: atLeastZero(preferential),
    isSSTB: options.isSSTB ?? false,
    filingStatus,
    pack,
  });
  for (const w of qbiResult.warnings) warnings.push(w);

  const taxableIncome = atLeastZero(taxableIncomeBeforeQbi - qbiResult.deduction);

  /* Preferential income is taxed at its own rates, but STACKED on top of ordinary income.
   * Split taxable income into the two parts, tax the ordinary part at ordinary rates, then
   * fill the capital-gains bands starting from wherever the ordinary income left off.
   *
   * Note that preferential income is capped at total taxable income: if deductions have
   * already eaten into it, only what survives is taxed. */
  const preferentialTaxable = Math.min(atLeastZero(preferential), taxableIncome);
  const ordinaryTaxable = atLeastZero(taxableIncome - preferentialTaxable);

  const ordinaryTax = bracketTax(ordinaryTaxable, brackets);

  const cgBrackets = pack.capitalGainsBrackets?.[filingStatus];
  let capitalGainsTax = 0;
  let capitalGainsBands = [];

  if (preferentialTaxable > 0) {
    if (!cgBrackets) {
      // Better to tax it at ordinary rates and say so than to silently drop it.
      capitalGainsTax = bracketTax(taxableIncome, brackets) - ordinaryTax;
      warnings.push({ code: 'tax.preferential_not_modeled', data: { preferential } });
    } else {
      const result = preferentialTax(ordinaryTaxable, preferentialTaxable, cgBrackets);
      capitalGainsTax = result.tax;
      capitalGainsBands = result.bands;
    }
  }

  const credits = options.credits ?? 0;

  const totalLiability = atLeastZero(
    ordinaryTax + capitalGainsTax + seTaxTotal + additionalMedicare.tax - credits,
  );

  return {
    filingStatus,
    packId: pack.packId,
    taxYear: pack.taxYear,

    grossIncome,
    deferrals,
    exemptIncome: exempt,
    preferentialIncome: preferential,
    seDeductibleHalf: seDeductible,
    aboveTheLine,
    agi,

    deduction,
    standardDeduction: standard,
    itemizedDeduction: itemized,
    usedItemized,
    taxableIncomeBeforeQbi,
    qbiDeduction: qbiResult.deduction,
    qbi: qbiResult,
    taxableIncome,
    ordinaryTaxable,
    preferentialTaxable,

    ordinaryTax,
    capitalGainsTax,
    capitalGainsBands,
    selfEmploymentTax: seTaxTotal,
    additionalMedicare: additionalMedicare.tax,
    ficaWithheldEquivalent: ficaTotal,
    credits,
    totalLiability,

    effectiveOnAGI: rate(totalLiability, agi),
    effectiveOnGross: rate(totalLiability, grossIncome),
    statutoryBracket: statutoryBracketRate(taxableIncome, brackets),

    perPerson,
    warnings,
  };
}

function rate(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return numerator / denominator;
}

/**
 * The marginal rate, measured by adding a dollar of ordinary income and re-running.
 *
 * Deliberately NOT a bracket lookup. Reading "the bracket you are in" is wrong wherever a
 * phase-out, the self-employment deduction feedback loop, or preferential stacking is in
 * play — and it is wrong in a way nobody notices. Two extra evaluations per year is
 * nothing, and the number is then true by construction.
 */
export function marginalRate(yearBook, household, pack, options = {}, category = 'other_ordinary') {
  const baseline = computeFederal(yearBook, household, pack, options).totalLiability;

  const personId = Object.keys(yearBook)[0] ?? 'household';
  const probed = structuredClone(yearBook);
  probed[personId] ??= {};
  probed[personId][category] = (probed[personId][category] ?? 0) + PROBE_CENTS;

  const bumped = computeFederal(probed, household, pack, options).totalLiability;
  return (bumped - baseline) / PROBE_CENTS;
}

/**
 * Effective and marginal rates, returned as separately named fields.
 *
 * There is deliberately no field called `taxRate`. Conflating the effective and marginal
 * rate is the single most common way tax figures get misread, so the model never offers a
 * name that could mean either.
 */
export function rateSummary(yearBook, household, pack, options = {}) {
  const result = computeFederal(yearBook, household, pack, options);
  return {
    effectiveOnAGI: result.effectiveOnAGI,
    effectiveOnGross: result.effectiveOnGross,
    marginalOrdinary: marginalRate(yearBook, household, pack, options, 'other_ordinary'),
    marginalIncludingPayroll: marginalRate(yearBook, household, pack, options, 'se_net_profit'),
    statutoryBracket: result.statutoryBracket,
  };
}

/** Sum a book across people and categories — used for display and sanity checks. */
export function totalTaxableIn(yearBook) {
  return sumCents(
    Object.values(yearBook).flatMap((person) => Object.values(person)),
  );
}
