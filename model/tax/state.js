/**
 * State income tax.
 *
 * States differ less in their arithmetic than in what they tax. Most start from a federal
 * figure and adjust it, so a pack declares its `basis`:
 *
 *   federal_taxable_income   start from federal taxable income (Colorado does this)
 *   federal_agi              start from federal AGI, then apply the state's own deduction
 *   own                      the state computes its own base from the income buckets
 *
 * Getting the basis wrong is worse than getting the rate wrong: a state that taxes federal
 * taxable income already benefits from the federal standard deduction, and applying a
 * second one silently understates the bill.
 *
 * A pack whose figures have not been verified against the state's own publication is
 * marked `status: "unverified"` and produces a warning on every use. It is better to show
 * a clearly-labelled estimate than to imply a precision nobody checked.
 */

import { atLeastZero, scaleCents } from '../money.js';
import { bracketTax } from './rule-pack.js';

export const STATE_BASES = Object.freeze(['federal_taxable_income', 'federal_agi', 'own']);

export class StateTaxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateTaxError';
    this.code = code;
  }
}

/**
 * @param {Object} federal   the federal result for the same year
 * @param {Object} pack      a state rule pack
 * @param {Object} household
 * @returns {{tax, base, taxableBase, effectiveRate, warnings, packLabel}}
 */
export function computeState(federal, pack, household) {
  const warnings = [];
  if (!pack) return null;

  const { filingStatus } = household;

  if (!STATE_BASES.includes(pack.basis)) {
    throw new StateTaxError('state.bad_basis',
      `state pack ${pack.packId} declares basis "${pack.basis}"; expected one of ${STATE_BASES.join(', ')}`);
  }

  if (pack.status === 'unverified') {
    warnings.push({
      code: 'tax.state_pack_unverified',
      data: { state: pack.jurisdiction?.state ?? pack.packId, year: pack.taxYear },
    });
  }

  /* What the state starts from. */
  let base;
  switch (pack.basis) {
    case 'federal_taxable_income':
      // Already net of the federal deduction. Applying a state deduction on top would
      // deduct twice.
      base = federal.taxableIncome;
      break;
    case 'federal_agi':
      base = federal.agi;
      break;
    case 'own':
      base = federal.grossIncome;
      break;
    default:
      base = 0;
  }

  /* State-specific additions and subtractions, as flat amounts from the pack. */
  const additions = pack.additions?.[filingStatus] ?? pack.additions?.all ?? 0;
  const subtractions = pack.subtractions?.[filingStatus] ?? pack.subtractions?.all ?? 0;
  const stateDeduction = pack.standardDeduction?.[filingStatus] ?? 0;
  const exemption = pack.personalExemption
    ? pack.personalExemption * (household.people?.length ?? 1)
    : 0;

  const taxableBase = atLeastZero(base + additions - subtractions - stateDeduction - exemption);

  /* Flat rate or brackets. */
  let tax = 0;
  if (typeof pack.flatRate === 'number') {
    tax = scaleCents(taxableBase, pack.flatRate);
  } else if (pack.brackets?.[filingStatus]) {
    tax = bracketTax(taxableBase, pack.brackets[filingStatus]);
  } else {
    throw new StateTaxError('state.no_rates',
      `state pack ${pack.packId} has neither a flatRate nor brackets for "${filingStatus}"`);
  }

  const credits = pack.credits?.[filingStatus] ?? 0;
  tax = atLeastZero(tax - credits);

  return {
    packId: pack.packId,
    state: pack.jurisdiction?.state ?? null,
    taxYear: pack.taxYear,
    status: pack.status,
    basis: pack.basis,
    base,
    taxableBase,
    stateDeduction,
    exemption,
    credits,
    tax,
    effectiveRate: federal.grossIncome > 0 ? tax / federal.grossIncome : 0,
    warnings,
  };
}

/** Validate a state pack. Returns a list of problems; empty means usable. */
export function validateStatePack(pack) {
  const problems = [];

  if (pack.jurisdiction?.level !== 'state') problems.push('a state pack must declare level "state"');
  if (!pack.jurisdiction?.state) problems.push('a state pack must name its state');
  if (!STATE_BASES.includes(pack.basis)) problems.push(`basis must be one of ${STATE_BASES.join(', ')}`);
  if (pack.units !== 'cents') problems.push('units must be "cents"');

  const hasFlat = typeof pack.flatRate === 'number';
  const hasBrackets = pack.brackets && Object.keys(pack.brackets).length > 0;
  if (!hasFlat && !hasBrackets) problems.push('a state pack needs either a flatRate or brackets');
  if (hasFlat && (pack.flatRate < 0 || pack.flatRate >= 1)) {
    problems.push(`flatRate ${pack.flatRate} is not a fraction below 1`);
  }

  if (pack.status === 'unverified' && pack.lastVerified) {
    problems.push('a pack marked unverified must not claim a verification date');
  }
  if (pack.status !== 'unverified' && !pack.lastVerified) {
    problems.push('a verified pack must carry lastVerified');
  }

  for (const [name, value] of Object.entries(pack.standardDeduction ?? {})) {
    if (!Number.isSafeInteger(value)) problems.push(`standardDeduction.${name} is not integer cents`);
  }

  return problems;
}

/** "Colorado 2026 — UNVERIFIED" or "Colorado 2026 — verified 2026-08-11". */
export function stateLabel(pack) {
  const name = pack.jurisdiction?.stateName ?? pack.jurisdiction?.state ?? pack.packId;
  return pack.status === 'unverified'
    ? `${name} ${pack.taxYear} — UNVERIFIED`
    : `${name} ${pack.taxYear} — verified ${pack.lastVerified}`;
}
