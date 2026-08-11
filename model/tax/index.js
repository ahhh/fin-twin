/**
 * Pass A: the tax pass.
 *
 * Reads the taxable book and the withholding already in the event stream, produces a
 * result per tax year, and emits the cash events those results imply — quarterly
 * instalments and the April true-up.
 *
 * This pass NEVER reads a balance. That is what makes the two-pass engine non-circular:
 * the whole future is compiled before any cash walks, so the year's income is fully known
 * here even though the payments it produces are cash events inside that same year.
 */

import { makeEvent, sortEvents } from '../events.js';
import { makeWarning } from '../warnings.js';
import { isWithin, yearOf } from '../dates.js';
import { sumCents } from '../money.js';
import { computeFederal, marginalRate } from './federal.js';
import { buildRemittanceSchedule, reconcile } from './estimated.js';
import { selectPackForYear, packLabel } from './rule-pack.js';
import { computeState, stateLabel } from './state.js';

export const TAX_SOURCE_ID = 'system:tax:federal';

/**
 * @param {Object} args
 * @param {Object} args.book        {year: {personId: {category: cents}}}
 * @param {Array}  args.events      the realised event stream (for withholding totals)
 * @param {Array}  args.packs       loaded rule packs
 * @param {Object} args.household
 * @param {Object} args.horizon
 * @param {Array}  [args.statePacks] state rule packs, applied on top of federal
 * @param {Object} [args.priorYear] {liability, agi} from before the projection starts
 * @returns {{taxEvents: Array, yearResults: Object, warnings: Array}}
 */
export function taxPass({ book, events, packs, statePacks = [], household, horizon, priorYear = null }) {
  const warnings = [];
  const taxEvents = [];
  const yearResults = {};

  if (!packs || packs.length === 0) {
    return { taxEvents, yearResults, warnings };
  }

  const withheldByYear = withholdingByYear(events);
  const payrollByYear = payrollTaxByYear(events);
  const years = [...new Set([
    ...Object.keys(book).map(Number),
    ...Object.keys(withheldByYear).map(Number),
  ])].sort((a, b) => a - b);

  // Carried forward year to year: this year's liability is next year's safe-harbour basis.
  let priorLiability = priorYear?.liability ?? null;
  let priorAgi = priorYear?.agi ?? null;

  for (const year of years) {
    const { pack, extrapolated, usedYear } = selectPackForYear(packs, year);
    if (extrapolated) {
      warnings.push(makeWarning('tax.no_rule_pack', { year, usedYear }));
    }

    const yearBook = book[year] ?? {};
    const federal = computeFederal(yearBook, household, pack);
    for (const w of federal.warnings) warnings.push(makeWarning(w.code, w.data));

    /* State tax sits on top of the federal result, and is part of what has to be paid. */
    let state = null;
    if (statePacks.length > 0) {
      const chosen = selectPackForYear(statePacks, year);
      state = computeState(federal, chosen.pack, household);
      if (state) {
        for (const w of state.warnings) warnings.push(makeWarning(w.code, w.data));
        if (chosen.extrapolated) {
          warnings.push(makeWarning('tax.no_rule_pack', { year, usedYear: chosen.usedYear }));
        }
      }
    }

    /* SIMPLIFICATION worth knowing about: federal and state estimated payments are
     * separate in reality, with their own due dates and safe-harbour rules. They are
     * scheduled together here because the question this tool answers is "how much do I
     * need to set aside", and one combined figure answers it. The split is reported per
     * year on `federalLiability` and `stateTax`. */
    const stateTax = state?.tax ?? 0;
    const withheld = withheldByYear[year] ?? 0;

    const schedule = buildRemittanceSchedule({
      liability: federal.totalLiability + stateTax,
      withheld,
      priorYearLiability: priorLiability,
      priorYearAgi: priorAgi,
      pack,
    });
    for (const w of schedule.warnings) warnings.push(makeWarning(w.code, { year, ...w.data }));

    // The identity that proves the events and the result agree.
    const residual = reconcile({
      liability: federal.totalLiability + stateTax,
      withheld,
      instalments: schedule.instalments,
      trueUp: schedule.trueUp,
    });
    if (residual !== 0) {
      throw new Error(
        `tax reconciliation failed for ${year}: liability ${federal.totalLiability + stateTax} − withheld ` +
        `${withheld} − instalments − true-up leaves ${residual} cents unaccounted for`,
      );
    }

    yearResults[year] = {
      ...federal,
      // The headline figure is federal PLUS state, because that is what gets paid.
      federalLiability: federal.totalLiability,
      stateTax,
      state,
      stateLabel: state ? stateLabel(selectPackForYear(statePacks, year).pack) : null,
      totalLiability: federal.totalLiability + stateTax,
      packLabel: packLabel(pack),
      extrapolated,
      withheld,
      payrollTaxWithheld: payrollByYear[year] ?? 0,
      requiredEstimated: schedule.required,
      safeHarbourBasis: schedule.basis,
      instalments: schedule.instalments,
      estimatedPaid: schedule.estimatedPaid,
      trueUp: schedule.trueUp,
      balanceDue: schedule.balanceDue,
      refund: schedule.refund,
      marginalOrdinary: marginalRate(yearBook, household, pack, {}, 'other_ordinary'),
      marginalIncludingPayroll: marginalRate(yearBook, household, pack, {}, 'se_net_profit'),
      // Set when the run blends uncertain income: E[tax(X)] is not tax(E[X]), so an
      // expected-value liability corresponds to no possible world. The UI labels it.
      blendedApproximation: false,
    };

    /* ---- the cash events those results imply ---- */

    for (const instalment of schedule.instalments) {
      if (instalment.amount === 0) continue;
      if (!isWithin(instalment.date, horizon.startDate, horizon.endDate)) continue;
      taxEvents.push(makeEvent({
        sourceId: `${TAX_SOURCE_ID}:${year}`,
        date: instalment.date,
        kind: 'tax_payment',
        phase: 'ESTIMATED_TAX',
        account: 'cash',
        cashAmount: -instalment.amount,
        category: 'tax',
        label: `Estimated federal tax — ${year} Q${instalment.quarter}`,
        tags: ['estimated-tax', 'tax'],
        seq: instalment.quarter,
        meta: { taxYear: year, quarter: instalment.quarter },
      }));
    }

    const trueUp = schedule.trueUp;
    if (trueUp.amount !== 0 && isWithin(trueUp.date, horizon.startDate, horizon.endDate)) {
      taxEvents.push(makeEvent({
        sourceId: `${TAX_SOURCE_ID}:${year}`,
        date: trueUp.date,
        kind: trueUp.isRefund ? 'tax_refund' : 'tax_payment',
        phase: 'TAX_TRUE_UP',
        account: 'cash',
        cashAmount: -trueUp.amount,
        category: 'tax',
        label: trueUp.isRefund
          ? `Federal refund — ${year} return`
          : `Federal balance due — ${year} return`,
        tags: ['tax', trueUp.isRefund ? 'refund' : 'balance-due'],
        seq: 0,
        meta: { taxYear: year },
      }));
    }

    // Carried into next year's safe-harbour test as the COMBINED figure, matching the
    // combined schedule above.
    priorLiability = federal.totalLiability + stateTax;
    priorAgi = federal.agi;
  }

  return { taxEvents: sortEvents(taxEvents), yearResults, warnings };
}

/**
 * INCOME TAX withholding already taken at source, by tax year.
 *
 * Deliberately excludes payroll tax. Employee FICA is withheld and finished with — it is
 * not a prepayment against the income tax bill and never settles up on the return (bar
 * excess Social Security across two employers, which is handled as a credit). Counting it
 * here would inflate every refund by the whole of the year's FICA.
 */
export function withholdingByYear(events) {
  const out = Object.create(null);
  for (const event of events) {
    if (event.kind !== 'withholding') continue;
    if (!event.tags.includes('income-tax')) continue;
    const year = yearOf(event.date);
    out[year] = (out[year] ?? 0) + -event.cashAmount;
  }
  return out;
}

/** Payroll tax withheld, reported separately because it reconciles differently. */
export function payrollTaxByYear(events) {
  const out = Object.create(null);
  for (const event of events) {
    if (event.kind !== 'withholding' || !event.tags.includes('payroll-tax')) continue;
    const year = yearOf(event.date);
    out[year] = (out[year] ?? 0) + -event.cashAmount;
  }
  return out;
}

/**
 * What is still owed beyond what has been withheld and paid — the number behind the
 * "tax reserve gap" KPI.
 */
export function unfundedLiability(yearResult) {
  return Math.max(0, yearResult.totalLiability - yearResult.withheld - yearResult.estimatedPaid);
}

/** Total tax across every modelled year, for the summary cards. */
export function totalLiabilityAcross(yearResults) {
  return sumCents(Object.values(yearResults).map((r) => r.totalLiability));
}
