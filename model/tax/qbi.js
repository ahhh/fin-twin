/**
 * The qualified business income deduction (§199A).
 *
 * Worth being blunt about the scope. The full rule is genuinely complicated — W-2 wage and
 * property limits, aggregation elections, REIT and PTP income, carryforward of losses. What
 * is implemented here is the part that applies to most people with a Schedule C:
 *
 *   deduction = min( 20% of QBI , 20% of (taxable income − net capital gain) )
 *
 * plus the two things that most often change the answer:
 *
 *   - the SSTB phase-out. Above the threshold, a "specified service" business (consulting,
 *     law, health, accounting, athletics, financial services…) loses the deduction on a
 *     sliding scale, and above the top of the phase-in range gets nothing at all.
 *   - the taxable-income limit, which is why a large capital gain can shrink the
 *     deduction even though it has nothing to do with the business.
 *
 * NOT implemented: the W-2 wage and unadjusted-basis limits that cap a NON-service business
 * above the threshold. A user with a large non-service business and few employees will see
 * a deduction here that is too generous, and `qbi.above_threshold_unlimited` says so
 * rather than letting the number pass unremarked.
 *
 * Every figure comes from the rule pack.
 */

import { atLeastZero, scaleCents } from '../money.js';

/**
 * @param {Object} args
 * @param {number} args.qbi              qualified business income
 * @param {number} args.taxableIncome    before this deduction
 * @param {number} args.netCapitalGain   preferential income included in taxable income
 * @param {boolean} args.isSSTB          a specified service trade or business
 * @param {string} args.filingStatus
 * @param {Object} args.pack
 * @returns {{deduction, limitedBy, warnings, phaseOutFraction, appliedRate}}
 */
export function computeQbi({ qbi, taxableIncome, netCapitalGain = 0, isSSTB = false, filingStatus, pack }) {
  const rules = pack.qbi;
  const warnings = [];

  if (!rules) return { deduction: 0, limitedBy: 'not-modelled', warnings, phaseOutFraction: 0, appliedRate: 0 };
  if (qbi <= 0) return { deduction: 0, limitedBy: 'no-qbi', warnings, phaseOutFraction: 0, appliedRate: 0 };

  const threshold = rules.threshold[filingStatus];
  const phaseInTop = rules.phaseInTop[filingStatus];
  if (threshold === undefined || phaseInTop === undefined) {
    return { deduction: 0, limitedBy: 'no-threshold', warnings, phaseOutFraction: 0, appliedRate: 0 };
  }

  /* How far into the phase-in range the taxpayer sits. 0 = below the threshold and fully
   * eligible; 1 = above the top of the range. */
  const range = phaseInTop - threshold;
  const over = atLeastZero(taxableIncome - threshold);
  const phaseOutFraction = range <= 0 ? (over > 0 ? 1 : 0) : Math.min(1, over / range);

  /* A specified service business loses the deduction across that range. */
  let eligibleQbi = qbi;
  if (isSSTB && phaseOutFraction > 0) {
    if (phaseOutFraction >= 1) {
      warnings.push({ code: 'qbi.sstb_phased_out', data: { threshold: phaseInTop } });
      return { deduction: 0, limitedBy: 'sstb-phased-out', warnings, phaseOutFraction, appliedRate: 0 };
    }
    eligibleQbi = scaleCents(qbi, 1 - phaseOutFraction);
    warnings.push({ code: 'qbi.sstb_phasing_out', data: { remaining: Math.round((1 - phaseOutFraction) * 100) } });
  }

  /* Above the threshold a non-service business is capped by W-2 wages and property, which
   * this version does not model. Flag it rather than quietly over-deducting. */
  if (!isSSTB && phaseOutFraction > 0) {
    warnings.push({ code: 'qbi.above_threshold_unlimited', data: { threshold } });
  }

  const fromQbi = scaleCents(eligibleQbi, rules.rate);

  // The overall limit: 20% of taxable income EXCLUDING net capital gain. This is why a big
  // gain can shrink a deduction that has nothing to do with it.
  const incomeBase = atLeastZero(taxableIncome - atLeastZero(netCapitalGain));
  const fromIncome = scaleCents(incomeBase, rules.rate);

  const deduction = Math.min(fromQbi, fromIncome);

  return {
    deduction,
    limitedBy: deduction === fromIncome && fromIncome < fromQbi ? 'taxable-income' : 'qbi',
    phaseOutFraction,
    appliedRate: rules.rate,
    fromQbi,
    fromIncome,
    warnings,
  };
}

/**
 * Which income counts as QBI.
 *
 * Self-employment profit less the deductible half of SE tax — the deduction is computed on
 * business income net of that adjustment, not on gross profit. Wages never count: a salary
 * is not qualified business income no matter who pays it.
 */
export function qbiFromBook(personTotals, seDeductibleHalf = 0) {
  return atLeastZero((personTotals.selfEmployment ?? 0) - seDeductibleHalf);
}
