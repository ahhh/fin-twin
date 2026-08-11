/**
 * Derived measures.
 *
 * Every metric returns `{value, unit, definition, inputs}` rather than a bare number. The
 * definition travels with the figure because several of these have more than one defensible
 * meaning — "savings rate" especially — and a number whose definition is implicit is a
 * number people misread. The UI renders the definition next to the value.
 *
 * Nothing here computes money outside the event stream: every cash figure is a sum over
 * events or a balance the ledger produced.
 */

import { sumCents } from './money.js';
import { sumCash } from './events.js';

const metric = (value, unit, definition, inputs = {}) =>
  Object.freeze({ value, unit, definition, inputs });

const DEFAULT_LIQUID = ['cash', 'savings'];

/* -------------------------------------------------------------------------- */
/* Building blocks                                                             */
/* -------------------------------------------------------------------------- */

/** Average monthly ESSENTIAL spending — the denominator of the emergency-fund figure. */
export function monthlyEssentialSpend(run) {
  const essential = run.events.filter((e) => e.kind === 'expense' && e.essential === true);
  if (essential.length === 0) return 0;
  const total = -sumCents(essential.map((e) => e.cashAmount));
  return Math.round(total / Math.max(1, run.months.length));
}

export function monthlyTotalSpend(run) {
  const total = -sumCash(run.events, (e) => e.kind === 'expense');
  return Math.round(total / Math.max(1, run.months.length));
}

const liquidAccounts = (run) => new Set(run.liquidAccounts ?? DEFAULT_LIQUID);

export function liquidBalance(run) {
  const liquid = liquidAccounts(run);
  return sumCents(
    Object.entries(run.balances).filter(([a]) => liquid.has(a)).map(([, v]) => v),
  );
}

/* -------------------------------------------------------------------------- */
/* Metrics                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Months of essential spending covered by liquid savings.
 *
 * Deliberately measured against ESSENTIAL spending, not all spending. An emergency budget
 * is not a normal budget, and using total spending inflates the target — often enough to
 * make a perfectly sound reserve look inadequate.
 */
export function emergencyMonths(run) {
  const essential = monthlyEssentialSpend(run);
  const liquid = liquidBalance(run);
  return metric(
    essential === 0 ? null : liquid / essential,
    'months',
    'Liquid savings divided by average monthly essential spending. Essential spending is what you would still pay if income stopped.',
    { liquid, monthlyEssential: essential },
  );
}

/** The lowest liquid balance in the projection, and when it happens. */
export function minimumCash(run) {
  return metric(
    run.minLiquid?.amount ?? null,
    'cents',
    'The lowest your liquid accounts get at any point, including part-way through a month. A month can close positive after dipping below zero.',
    {
      period: run.minLiquid?.period ?? null,
      date: run.minLiquid?.date ?? null,
      cause: run.minLiquid?.label ?? null,
    },
  );
}

/** The first month liquid cash falls below a target, or null if it never does. */
export function firstShortfall(run, targetCents) {
  const month = run.months.find((m) => m.liquid < targetCents);
  return metric(
    month?.period ?? null,
    'period',
    'The first month your liquid balance ends below the target you set.',
    { target: targetCents },
  );
}

/**
 * How long liquid cash would last at the current burn rate if income stopped.
 *
 * Uses essential spending only, for the same reason as the emergency figure.
 */
export function cashRunway(run) {
  const essential = monthlyEssentialSpend(run);
  const liquid = liquidBalance(run);
  return metric(
    essential === 0 ? null : liquid / essential,
    'months',
    'How many months of essential spending your liquid savings would cover if all income stopped today.',
    { liquid, monthlyEssential: essential },
  );
}

/**
 * Savings rate, in both common senses.
 *
 * These routinely differ by a factor of two, so the model returns both, each labelled,
 * and never a single unqualified "savings rate".
 */
export function savingsRates(run) {
  const grossEarned = sumCash(run.events, (e) => e.kind === 'income');
  const withheld = -sumCash(run.events, (e) => e.kind === 'withholding');
  const taxPaid = -sumCash(run.events, (e) => e.kind === 'tax_payment' || e.kind === 'tax_refund');
  const afterTaxCash = grossEarned - withheld - taxPaid;
  const spent = -sumCash(run.events, (e) => e.kind === 'expense');

  const contributions = -sumCash(
    run.events,
    (e) => e.kind === 'contribution' && e.cashAmount < 0,
  );

  return {
    cash: metric(
      afterTaxCash === 0 ? null : (afterTaxCash - spent) / afterTaxCash,
      'ratio',
      'Cash savings rate: what is left of your after-tax income once spending is taken out.',
      { afterTaxCash, spent },
    ),
    longTerm: metric(
      grossEarned === 0 ? null : contributions / grossEarned,
      'ratio',
      'Long-term savings rate: retirement and investment contributions as a share of gross earned income.',
      { contributions, grossEarned },
    ),
  };
}

/**
 * The share of income that is variable rather than dependable.
 *
 * Variable means it came from a source carrying uncertainty, or from a category that is
 * inherently lumpy (contract, royalty, windfall). A high share is not bad in itself — it
 * is a reason to hold a larger reserve.
 */
export function variableIncomeShare(run) {
  const income = run.events.filter((e) => e.kind === 'income');
  const total = sumCents(income.map((e) => e.cashAmount));
  const uncertain = new Set(run.uncertainSourceIds ?? []);

  const variable = sumCents(
    income
      .filter((e) => uncertain.has(e.sourceId) || e.tags.includes('variable-income'))
      .map((e) => e.cashAmount),
  );

  return metric(
    total === 0 ? null : variable / total,
    'ratio',
    'The share of projected income that is variable — uncertain, or from lumpy sources like contracts and royalties.',
    { variable, total },
  );
}

/**
 * How concentrated income is in one source.
 *
 * Not automatically a problem; a risk-awareness indicator. "62% of your income comes from
 * one client" is worth knowing before the client leaves, not after.
 */
export function incomeConcentration(run) {
  const bySource = new Map();
  for (const event of run.events) {
    if (event.kind !== 'income') continue;
    bySource.set(event.sourceId, (bySource.get(event.sourceId) ?? 0) + event.cashAmount);
  }

  const totals = [...bySource.entries()].sort((a, b) => b[1] - a[1]);
  const total = sumCents(totals.map(([, v]) => v));
  if (total === 0) {
    return {
      largest: metric(null, 'ratio', 'The largest single income source as a share of all income.', {}),
      topThree: metric(null, 'ratio', 'The three largest income sources as a share of all income.', {}),
    };
  }

  const nameOf = (id) => run.sourcesResolved?.find((s) => s.id === id)?.name ?? id;
  const topThree = totals.slice(0, 3);

  return {
    largest: metric(
      totals[0][1] / total,
      'ratio',
      'The largest single income source as a share of all income.',
      { sourceId: totals[0][0], sourceName: nameOf(totals[0][0]), amount: totals[0][1], total },
    ),
    topThree: metric(
      sumCents(topThree.map(([, v]) => v)) / total,
      'ratio',
      'The three largest income sources as a share of all income.',
      { sources: topThree.map(([id, v]) => ({ id, name: nameOf(id), amount: v })), total },
    ),
  };
}

/**
 * Tax owed that nothing has been set aside for.
 *
 *     projected liability − withholding − estimated payments − earmarked cash
 *
 * The number that answers "how much of my bank balance is actually mine".
 */
export function taxReserveGap(run) {
  const years = Object.values(run.yearResults ?? {});

  // Floored PER YEAR, then summed. Netting across years would let a refund expected in
  // 2027 cancel a balance genuinely due in April — and that April payment still has to be
  // made out of real money, whatever next year holds.
  const unfundedByYear = years.map((y) =>
    Math.max(0, (y.totalLiability ?? 0) - (y.withheld ?? 0) - (y.estimatedPaid ?? 0)));

  const unfunded = sumCents(unfundedByYear);
  const earmarked = run.balances?.tax_reserve ?? 0;

  return metric(
    Math.max(0, unfunded - earmarked),
    'cents',
    'Projected tax not yet covered by withholding, estimated payments, or money set aside. Each year is counted separately, so a future refund never cancels tax due sooner.',
    {
      unfunded,
      earmarked,
      liability: sumCents(years.map((y) => y.totalLiability ?? 0)),
      withheld: sumCents(years.map((y) => y.withheld ?? 0)),
      estimated: sumCents(years.map((y) => y.estimatedPaid ?? 0)),
      byYear: Object.fromEntries(Object.keys(run.yearResults ?? {}).map((y, i) => [y, unfundedByYear[i]])),
    },
  );
}

/**
 * What is genuinely free to spend.
 *
 * Bank balance alone overstates this whenever tax is owed or money is earmarked. This is
 * the figure the plan calls out as more useful than the bank balance.
 */
export function spendableCash(run) {
  const liquid = liquidBalance(run);
  const gap = taxReserveGap(run).value;
  const earmarked = sumCents(
    Object.entries(run.balances)
      .filter(([account]) => account.startsWith('sink_') || account === 'tax_reserve')
      .map(([, value]) => value),
  );

  return metric(
    liquid - gap,
    'cents',
    'Liquid cash less tax you owe but have not set aside. Money already earmarked in a reserve account is excluded from liquid cash, not deducted twice.',
    { liquid, unfundedTax: gap, earmarked },
  );
}

/** Assets minus liabilities across every account the model touches. */
export function netWorth(run) {
  return metric(
    sumCents(Object.values(run.balances)),
    'cents',
    'Every modelled account added together. This version does not model debt balances, so it is assets only.',
    { accounts: Object.keys(run.balances).sort() },
  );
}

/** Effective and marginal rates for a year, kept separate and separately named. */
export function taxRates(run, year) {
  const result = run.yearResults?.[year];
  if (!result) return null;
  return {
    effectiveOnGross: metric(result.effectiveOnGross, 'ratio',
      'Total tax divided by gross income — what you actually paid overall.'),
    effectiveOnAGI: metric(result.effectiveOnAGI, 'ratio',
      'Total tax divided by adjusted gross income.'),
    marginalOrdinary: metric(result.marginalOrdinary, 'ratio',
      'The rate the next dollar of ordinary income would be taxed at. Not the same as the effective rate.'),
    marginalIncludingPayroll: metric(result.marginalIncludingPayroll, 'ratio',
      'The rate on the next dollar of self-employment income, including payroll tax.'),
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Every metric for a run.
 *
 * @param {Object} run
 * @param {Object} [options]
 * @param {number} [options.emergencyTargetMonths=3]
 */
export function computeMetrics(run, options = {}) {
  const targetMonths = options.emergencyTargetMonths ?? 3;
  const essential = monthlyEssentialSpend(run);
  const savings = savingsRates(run);
  const concentration = incomeConcentration(run);

  return Object.freeze({
    netWorth: netWorth(run),
    liquidCash: metric(liquidBalance(run), 'cents', 'The total of your cash and savings accounts.'),
    spendableCash: spendableCash(run),
    minimumCash: minimumCash(run),
    emergencyMonths: emergencyMonths(run),
    emergencyTarget: metric(essential * targetMonths, 'cents',
      `${targetMonths} months of essential spending.`, { targetMonths, monthlyEssential: essential }),
    firstShortfall: firstShortfall(run, essential * targetMonths),
    cashRunway: cashRunway(run),
    monthlyEssentialSpend: metric(essential, 'cents',
      'Average monthly spending on things flagged essential.'),
    monthlySpend: metric(monthlyTotalSpend(run), 'cents', 'Average monthly spending on everything.'),
    cashSavingsRate: savings.cash,
    longTermSavingsRate: savings.longTerm,
    variableIncomeShare: variableIncomeShare(run),
    incomeConcentration: concentration.largest,
    topThreeConcentration: concentration.topThree,
    taxReserveGap: taxReserveGap(run),
  });
}
