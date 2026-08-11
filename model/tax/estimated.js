/**
 * Estimated tax payments and the April true-up.
 *
 * The identity this module exists to satisfy, asserted as invariant #10:
 *
 *     liability − withheld − Σ instalments − trueUp === 0
 *
 * exactly, in cents, for every closed tax year. That identity IS the reconciliation; if it
 * holds, the tax events and the tax result cannot disagree.
 *
 * `allocate` does the splitting so four quarterly instalments sum to the requirement with
 * no drifting cent.
 */

import { allocate, atLeastZero, scaleCents, sumCents } from '../money.js';

/**
 * How much must be prepaid to stay inside safe harbour.
 *
 * The requirement is the LESSER of a share of this year's tax and a share of last year's —
 * that is the point of safe harbour: last year's number is known, so it is a target you
 * can actually hit.
 */
export function safeHarbourRequirement(currentLiability, priorYearLiability, priorYearAgi, pack) {
  const harbour = pack.estimatedTax.safeHarbor;
  const currentBased = scaleCents(currentLiability, harbour.currentYearPct);

  if (priorYearLiability === null || priorYearLiability === undefined) {
    return {
      required: currentBased,
      basis: 'current-year',
      priorYearKnown: false,
      priorYearPctUsed: null,
    };
  }

  const highIncome = (priorYearAgi ?? 0) > harbour.highIncomeAgiThreshold;
  const pct = highIncome ? harbour.priorYearPctHighIncome : harbour.priorYearPct;
  const priorBased = scaleCents(priorYearLiability, pct);

  return priorBased < currentBased
    ? { required: priorBased, basis: 'prior-year', priorYearKnown: true, priorYearPctUsed: pct }
    : { required: currentBased, basis: 'current-year', priorYearKnown: true, priorYearPctUsed: pct };
}

/**
 * Build the year's remittance schedule.
 *
 * @param {Object} args
 * @param {number} args.liability            this year's projected total tax
 * @param {number} args.withheld             projected withholding for the year
 * @param {number|null} args.priorYearLiability
 * @param {number|null} args.priorYearAgi
 * @param {Object} args.pack
 * @returns {{instalments: Array, trueUp: Object, required: number, basis: string,
 *           balanceDue: number, refund: number, warnings: Array}}
 */
export function buildRemittanceSchedule({ liability, withheld, priorYearLiability = null, priorYearAgi = null, pack }) {
  const warnings = [];
  const est = pack.estimatedTax;

  const harbour = safeHarbourRequirement(liability, priorYearLiability, priorYearAgi, pack);
  if (!harbour.priorYearKnown) {
    warnings.push({ code: 'tax.no_prior_year_liability', data: {} });
  }

  // Withholding counts toward the requirement, so only the shortfall needs paying in.
  const shortfall = atLeastZero(harbour.required - withheld);

  // Below the filing threshold, no estimated payments are required at all.
  const owed = atLeastZero(liability - withheld);
  const mustPay = owed >= est.filingThreshold ? shortfall : 0;

  const amounts = allocate(mustPay, est.installmentFractions);
  const instalments = est.dueDates.map((date, index) => ({
    date,
    amount: amounts[index],
    quarter: index + 1,
  }));

  const paid = sumCents(amounts);

  // Whatever is still outstanding lands on the true-up date. Positive means a payment,
  // negative means a refund. This is the term that closes the identity.
  const remaining = liability - withheld - paid;

  return {
    required: harbour.required,
    basis: harbour.basis,
    priorYearPctUsed: harbour.priorYearPctUsed,
    belowFilingThreshold: owed < est.filingThreshold,
    instalments,
    estimatedPaid: paid,
    trueUp: {
      date: est.trueUpDate,
      amount: remaining,
      isRefund: remaining < 0,
    },
    balanceDue: atLeastZero(remaining),
    refund: atLeastZero(-remaining),
    warnings,
  };
}

/**
 * Prove the reconciliation for a year. Returns 0 when the books close.
 *
 * Kept here rather than only in the test suite so the engine can assert it at runtime —
 * a silent mismatch between the tax result and the tax events would be invisible in the UI.
 */
export function reconcile({ liability, withheld, instalments, trueUp }) {
  const paid = sumCents(instalments.map((i) => i.amount));
  return liability - withheld - paid - trueUp.amount;
}
