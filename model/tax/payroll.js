/**
 * FICA and self-employment tax.
 *
 * Two coordination rules matter here, and both are easy to get wrong in ways that produce
 * a believable number:
 *
 *   The Social Security wage base is PER PERSON, and W-2 wages consume it first. Someone
 *   with $150k of wages and $50k of self-employment income owes Social Security SE tax on
 *   only the remaining room, not on the full $50k.
 *
 *   The Additional Medicare threshold is PER RETURN, not per person. A married couple
 *   earning $150k each cross it; neither does alone.
 *
 * Every rate and threshold comes from the rule pack.
 */

import { atLeastZero, scaleCents, sumCents } from '../money.js';

/**
 * Employee-side FICA on wages, tracking the wage base per person.
 *
 * @param {number} wagesCents      this person's wages for the year
 * @param {Object} pack
 * @returns {{socialSecurity: number, medicare: number, total: number, wageBaseUsed: number}}
 */
export function computeFica(wagesCents, pack) {
  const ss = pack.payroll.socialSecurity;
  const medicare = pack.payroll.medicare;

  const ssWages = Math.min(atLeastZero(wagesCents), ss.wageBase);
  const socialSecurity = scaleCents(ssWages, ss.rateEmployee);
  const medicareTax = scaleCents(atLeastZero(wagesCents), medicare.rateEmployee);

  return {
    socialSecurity,
    medicare: medicareTax,
    total: socialSecurity + medicareTax,
    wageBaseUsed: ssWages,
  };
}

/**
 * Self-employment tax for one person.
 *
 * @param {number} seNetProfitCents  net profit before the SE deduction
 * @param {number} w2WagesCents      this person's W-2 wages, which consume the wage base first
 */
export function computeSelfEmployment(seNetProfitCents, w2WagesCents, pack) {
  const se = pack.selfEmployment;
  const wageBase = pack.payroll.socialSecurity.wageBase;

  const netEarnings = scaleCents(atLeastZero(seNetProfitCents), se.netEarningsFactor);

  if (netEarnings < se.minimumNetEarnings) {
    return {
      netEarnings,
      belowMinimum: true,
      socialSecurity: 0,
      medicare: 0,
      total: 0,
      deductibleHalf: 0,
      ssRoomRemaining: atLeastZero(wageBase - atLeastZero(w2WagesCents)),
    };
  }

  // W-2 wages consume the Social Security wage base first.
  const ssRoom = atLeastZero(wageBase - atLeastZero(w2WagesCents));
  const ssEarnings = Math.min(netEarnings, ssRoom);

  const socialSecurity = scaleCents(ssEarnings, se.socialSecurityRate);
  const medicare = scaleCents(netEarnings, se.medicareRate);
  const total = socialSecurity + medicare;

  // Half of SE tax is an above-the-line deduction — computed EXCLUDING additional
  // Medicare, which is handled separately and is not halved.
  const deductibleHalf = scaleCents(total, se.deductibleFraction);

  return {
    netEarnings,
    belowMinimum: false,
    socialSecurity,
    medicare,
    total,
    deductibleHalf,
    ssRoomRemaining: atLeastZero(ssRoom - ssEarnings),
  };
}

/**
 * Additional Medicare tax.
 *
 * Computed on the HOUSEHOLD's combined wages plus SE net earnings against a per-return
 * threshold. Never halved into the SE deduction.
 */
export function computeAdditionalMedicare(combinedBaseCents, filingStatus, pack) {
  const rule = pack.payroll.additionalMedicare;
  const threshold = rule.threshold[filingStatus];
  if (threshold === undefined) {
    throw new Error(`no additional Medicare threshold for filing status "${filingStatus}"`);
  }
  const excess = atLeastZero(combinedBaseCents - threshold);
  return { excess, threshold, tax: scaleCents(excess, rule.rate) };
}

/**
 * Detect Social Security over-withholding across concurrent jobs.
 *
 * Each employer withholds up to the full wage base independently, so someone with two jobs
 * whose combined pay exceeds the base has genuinely over-paid and gets it back as a
 * refundable credit. Common, real money, and worth surfacing rather than quietly absorbing.
 *
 * @param {number[]} wagesPerEmployer  this person's wages from each employer
 */
export function computeSocialSecurityOverWithholding(wagesPerEmployer, pack) {
  const ss = pack.payroll.socialSecurity;

  const withheldPerEmployer = wagesPerEmployer.map((wages) =>
    scaleCents(Math.min(atLeastZero(wages), ss.wageBase), ss.rateEmployee));
  const totalWithheld = sumCents(withheldPerEmployer);

  const combined = sumCents(wagesPerEmployer.map(atLeastZero));
  const owed = scaleCents(Math.min(combined, ss.wageBase), ss.rateEmployee);

  return {
    combinedWages: combined,
    totalWithheld,
    owed,
    excess: atLeastZero(totalWithheld - owed),
    overWithheld: totalWithheld > owed,
  };
}
