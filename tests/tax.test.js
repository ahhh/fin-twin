import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_API, bracketTax, packLabel, selectPackForYear, statutoryBracketRate, validatePack,
} from '../model/tax/rule-pack.js';
import {
  computeAdditionalMedicare, computeFica, computeSelfEmployment,
  computeSocialSecurityOverWithholding,
} from '../model/tax/payroll.js';
import { computeFederal, marginalRate, rateSummary } from '../model/tax/federal.js';
import { buildRemittanceSchedule, reconcile, safeHarbourRequirement } from '../model/tax/estimated.js';
import { PACK_2026, book } from './helpers/packs.js';

const SINGLE = { filingStatus: 'single', people: [{ id: 'p1', name: 'Alex', birthYear: 1990 }] };
const MFJ = {
  filingStatus: 'married_joint',
  people: [{ id: 'p1', name: 'Alex', birthYear: 1990 }, { id: 'p2', name: 'Sam', birthYear: 1988 }],
};

/* ---- the pack itself ---- */

test('the shipped 2026 pack validates', () => {
  assert.deepEqual(validatePack(PACK_2026), []);
  assert.equal(PACK_2026.engineApi, ENGINE_API);
  assert.equal(packLabel(PACK_2026), 'US Federal 2026 — verified 2026-08-11');
});

test('the validator catches a pack typed in dollars instead of cents', () => {
  // The bug this exists for: $16,100 typed as 16100 produces a plausible-looking answer
  // that is wrong by two orders of magnitude.
  const broken = structuredClone(PACK_2026);
  broken.standardDeduction.single = 16100.5;
  const problems = validatePack(broken);
  assert.ok(problems.some((p) => p.includes('standardDeduction.single')));
});

test('the validator catches non-contiguous brackets and mistyped bases', () => {
  const gap = structuredClone(PACK_2026);
  gap.ordinaryBrackets.single[2].upTo = gap.ordinaryBrackets.single[1].upTo - 1;
  assert.ok(validatePack(gap).some((p) => p.includes('does not exceed the previous threshold')));

  const wrongBase = structuredClone(PACK_2026);
  wrongBase.ordinaryBrackets.single[3].base += 100;
  assert.ok(validatePack(wrongBase).some((p) => p.includes('accumulate to')),
    'a mistyped base must be caught by cross-checking against the rows above it');

  const openTop = structuredClone(PACK_2026);
  openTop.ordinaryBrackets.single[6].upTo = 99_999_999_00;
  assert.ok(validatePack(openTop).some((p) => p.includes('upTo: null')));
});

test('the validator refuses a pack from a newer engine', () => {
  const future = structuredClone(PACK_2026);
  future.engineApi = ENGINE_API + 1;
  assert.ok(validatePack(future).some((p) => p.includes('engineApi')));
});

test('a year with no pack carries the newest earlier one forward, marked extrapolated', () => {
  const chosen = selectPackForYear([PACK_2026], 2029);
  assert.equal(chosen.pack.taxYear, 2026);
  assert.equal(chosen.extrapolated, true, 'never silently reuse last year\'s brackets');
  assert.equal(chosen.usedYear, 2026);

  const exact = selectPackForYear([PACK_2026], 2026);
  assert.equal(exact.extrapolated, false);
});

/* ---- bracket arithmetic, checked against the published table ---- */

test('bracketTax matches the published 2026 single table at every boundary', () => {
  const single = PACK_2026.ordinaryBrackets.single;

  assert.equal(bracketTax(0, single), 0);
  assert.equal(bracketTax(1_240_000, single), 124_000, '10% up to $12,400');
  assert.equal(bracketTax(5_040_000, single), 580_000, 'top of the 12% band');
  assert.equal(bracketTax(10_570_000, single), 1_796_600, 'top of the 22% band');
  assert.equal(bracketTax(20_177_500, single), 4_102_400, 'top of the 24% band');
  assert.equal(bracketTax(25_622_500, single), 5_844_800, 'top of the 32% band');
  assert.equal(bracketTax(64_060_000, single), 19_297_925, 'top of the 35% band');

  // One dollar into the top bracket.
  assert.equal(bracketTax(64_060_100, single), 19_297_925 + 37);
});

test('head of household is not single with wider low brackets', () => {
  // Its 24% band ends at $201,750 and its 32% at $256,200 — both BELOW the single
  // figures. Deriving one table from the other would be quietly wrong for these filers.
  const hoh = PACK_2026.ordinaryBrackets.head_of_household;
  const single = PACK_2026.ordinaryBrackets.single;

  assert.equal(hoh[3].upTo, 20_175_000);
  assert.equal(single[3].upTo, 20_177_500);
  assert.ok(hoh[3].upTo < single[3].upTo, 'HoH 24% band ends lower than single');
  assert.equal(hoh[4].upTo, 25_620_000);
  assert.ok(hoh[4].upTo < single[4].upTo, 'HoH 32% band ends lower than single');
});

test('married filing separately tracks single until the top bracket splits', () => {
  const mfs = PACK_2026.ordinaryBrackets.married_separate;
  const single = PACK_2026.ordinaryBrackets.single;

  for (let i = 0; i < 5; i++) {
    assert.equal(mfs[i].upTo, single[i].upTo, `band ${i} should match single`);
  }
  assert.equal(mfs[5].upTo, 38_435_000, 'the 35% band ends at half the joint figure');
  assert.equal(single[5].upTo, 64_060_000);
});

test('statutoryBracketRate reports the band, separately from the effective rate', () => {
  assert.equal(statutoryBracketRate(5_000_000, PACK_2026.ordinaryBrackets.single), 0.12);
  assert.equal(statutoryBracketRate(70_000_000, PACK_2026.ordinaryBrackets.single), 0.37);
});

/* ---- a hand-computable return ---- */

test('a single W-2 earner on the standard deduction, to the cent', () => {
  const result = computeFederal(book({ w2_wages: 100_000_00 }), SINGLE, PACK_2026);

  assert.equal(result.grossIncome, 100_000_00);
  assert.equal(result.deduction, 16_100_00, 'the 2026 single standard deduction');
  assert.equal(result.taxableIncome, 83_900_00);

  // 22% band: $5,800 base + 22% of (83,900 − 50,400) = 5,800 + 7,370 = $13,170.
  assert.equal(result.ordinaryTax, 13_170_00);
  assert.equal(result.selfEmploymentTax, 0);
  assert.equal(result.additionalMedicare, 0);
  assert.equal(result.totalLiability, 13_170_00);

  assert.equal(result.statutoryBracket, 0.22);
  assert.ok(Math.abs(result.effectiveOnGross - 0.1317) < 1e-9,
    'the effective rate is far below the 22% band — the model must never conflate them');
});

test('a married couple filing jointly', () => {
  const result = computeFederal(
    { p1: { w2_wages: 120_000_00 }, p2: { w2_wages: 80_000_00 } },
    MFJ, PACK_2026,
  );

  assert.equal(result.grossIncome, 200_000_00);
  assert.equal(result.deduction, 32_200_00);
  assert.equal(result.taxableIncome, 167_800_00);
  // 22% band: $11,600 + 22% of (167,800 − 100,800) = 11,600 + 14,740 = $26,340.
  assert.equal(result.totalLiability, 26_340_00);
});

test('zero income owes nothing and never goes negative', () => {
  const result = computeFederal(book({ w2_wages: 0 }), SINGLE, PACK_2026);
  assert.equal(result.taxableIncome, 0);
  assert.equal(result.totalLiability, 0);
  assert.equal(result.effectiveOnGross, 0, 'no divide-by-zero');
});

/* ---- payroll and self-employment ---- */

test('FICA caps Social Security at the wage base but never caps Medicare', () => {
  const under = computeFica(100_000_00, PACK_2026);
  assert.equal(under.socialSecurity, 6_200_00);
  assert.equal(under.medicare, 1_450_00);

  const over = computeFica(300_000_00, PACK_2026);
  assert.equal(over.wageBaseUsed, 184_500_00, 'capped at the 2026 wage base');
  assert.equal(over.socialSecurity, 11_439_00, '6.2% of $184,500');
  assert.equal(over.medicare, 4_350_00, 'Medicare is uncapped');
});

test('W-2 wages consume the Social Security wage base before SE income does', () => {
  // The named case from the plan. Getting this wrong overstates SE tax for anyone with
  // both kinds of income.
  const se = computeSelfEmployment(50_000_00, 150_000_00, PACK_2026);

  assert.equal(se.netEarnings, 46_175_00, '92.35% of net profit');
  // Only $34,500 of wage base is left, so Social Security applies to that much.
  assert.equal(se.socialSecurity, 4_278_00, '12.4% of the remaining $34,500 of room');
  assert.equal(se.medicare, 1_339_08, '2.9% of the full net earnings — uncapped');
  assert.equal(se.total, 5_617_08);
  assert.equal(se.deductibleHalf, 2_808_54, 'half of SE tax is above the line');
});

test('self-employment with no wages pays Social Security on the whole net earnings', () => {
  const se = computeSelfEmployment(50_000_00, 0, PACK_2026);
  assert.equal(se.netEarnings, 46_175_00);
  assert.equal(se.socialSecurity, 5_725_70, '12.4% of the full net earnings');
  assert.equal(se.medicare, 1_339_08);
  assert.equal(se.deductibleHalf, se.total / 2);
});

test('tiny self-employment income falls below the threshold', () => {
  const se = computeSelfEmployment(300_00, 0, PACK_2026);
  assert.equal(se.belowMinimum, true);
  assert.equal(se.total, 0);
});

test('additional Medicare is per return, not per person', () => {
  // Two earners at $150k each cross the joint threshold; neither does alone.
  const each = computeAdditionalMedicare(150_000_00, 'married_joint', PACK_2026);
  assert.equal(each.tax, 0, 'one earner alone is under the $250,000 joint threshold');

  const combined = computeAdditionalMedicare(300_000_00, 'married_joint', PACK_2026);
  assert.equal(combined.excess, 50_000_00);
  assert.equal(combined.tax, 450_00, '0.9% of the excess over $250,000');

  const single = computeAdditionalMedicare(300_000_00, 'single', PACK_2026);
  assert.equal(single.tax, 900_00, 'the single threshold is $200,000');
});

test('two concurrent jobs over-withhold Social Security, and it comes back', () => {
  const result = computeSocialSecurityOverWithholding([120_000_00, 120_000_00], PACK_2026);

  assert.equal(result.combinedWages, 240_000_00);
  assert.equal(result.totalWithheld, 14_880_00, 'each employer withholds 6.2% of its own $120,000');
  assert.equal(result.owed, 11_439_00, 'but only the wage base is actually due');
  assert.equal(result.excess, 3_441_00);
  assert.ok(result.overWithheld);

  const oneJob = computeSocialSecurityOverWithholding([120_000_00], PACK_2026);
  assert.equal(oneJob.excess, 0);
});

/* ---- the double-count trap ---- */

test('a pre-tax deferral reduces taxable income exactly once', () => {
  const withoutDeferral = computeFederal(book({ w2_wages: 100_000_00 }), SINGLE, PACK_2026);
  const withDeferral = computeFederal(
    book({ w2_wages: 100_000_00, pretax_deferral: -10_000_00 }), SINGLE, PACK_2026,
  );

  assert.equal(withDeferral.agi, 90_000_00, 'exactly $10,000 lower, not $20,000');
  assert.equal(withoutDeferral.agi - withDeferral.agi, 10_000_00);
  assert.equal(withDeferral.taxableIncome, 73_900_00);
  // $10,000 out of the 22% band.
  assert.equal(withoutDeferral.totalLiability - withDeferral.totalLiability, 2_200_00);
});

test('a positive deferral is rejected rather than quietly added to income', () => {
  assert.throws(
    () => computeFederal(book({ w2_wages: 100_000_00, pretax_deferral: 10_000_00 }), SINGLE, PACK_2026),
    (err) => err.code === 'tax.deferral_sign',
  );
});

test('an unmapped taxable category is a hard error, not a silent zero', () => {
  assert.throws(
    () => computeFederal(book({ crypto_staking: 5_000_00 }), SINGLE, PACK_2026),
    (err) => err.code === 'tax.unmapped_category',
  );
});

test('a pack with no capital-gains table falls back to ordinary rates and says so', () => {
  // Better to overstate the tax and flag it than to silently drop the income.
  const noCgTable = structuredClone(PACK_2026);
  delete noCgTable.capitalGainsBrackets;

  const result = computeFederal(book({ w2_wages: 50_000_00, long_term_gains: 20_000_00 }), SINGLE, noCgTable);
  assert.ok(result.warnings.some((w) => w.code === 'tax.preferential_not_modeled'));
  assert.equal(result.preferentialIncome, 20_000_00);
  assert.ok(result.capitalGainsTax > 0, 'the gain is still taxed, just at the wrong rate');

  const proper = computeFederal(book({ w2_wages: 50_000_00, long_term_gains: 20_000_00 }), SINGLE, PACK_2026);
  assert.ok(proper.totalLiability < result.totalLiability, 'the fallback is deliberately high');
});

/* ---- marginal versus effective ---- */

test('the marginal rate is measured by probe, and is never called "the tax rate"', () => {
  const yearBook = book({ w2_wages: 100_000_00 });
  assert.equal(marginalRate(yearBook, SINGLE, PACK_2026), 0.22);

  const summary = rateSummary(yearBook, SINGLE, PACK_2026);
  assert.equal(summary.marginalOrdinary, 0.22);
  assert.ok(summary.effectiveOnGross < summary.marginalOrdinary);
  assert.equal(summary.taxRate, undefined, 'there must be no field that could mean either');
});

test('the marginal rate on self-employment income includes payroll tax', () => {
  const yearBook = book({ se_net_profit: 60_000_00 });
  const summary = rateSummary(yearBook, SINGLE, PACK_2026);

  assert.ok(
    summary.marginalIncludingPayroll > summary.marginalOrdinary,
    'the next dollar of self-employment income also carries SE tax',
  );
});

test('the probe is right even where the SE deduction feeds back', () => {
  // A bracket lookup would ignore that the deductible half of SE tax also moves.
  const yearBook = book({ se_net_profit: 200_000_00 });
  const probed = marginalRate(yearBook, SINGLE, PACK_2026, {}, 'se_net_profit');
  const lookup = computeFederal(yearBook, SINGLE, PACK_2026).statutoryBracket;
  assert.notEqual(probed, lookup, 'the true marginal rate differs from the bracket you are in');
});

/* ---- estimated tax ---- */

test('safe harbour takes the lesser of this year and last year', () => {
  const lower = safeHarbourRequirement(50_000_00, 20_000_00, 100_000_00, PACK_2026);
  assert.equal(lower.required, 20_000_00, '100% of a smaller prior year');
  assert.equal(lower.basis, 'prior-year');

  const current = safeHarbourRequirement(20_000_00, 50_000_00, 100_000_00, PACK_2026);
  assert.equal(current.required, 18_000_00, '90% of a smaller current year');
  assert.equal(current.basis, 'current-year');
});

test('high earners must prepay 110% of last year', () => {
  const high = safeHarbourRequirement(90_000_00, 40_000_00, 200_000_00, PACK_2026);
  assert.equal(high.priorYearPctUsed, 1.10, 'prior-year AGI above $150,000');
  assert.equal(high.required, 44_000_00);
});

test('with no prior year on file, safe harbour falls back and says so', () => {
  const first = safeHarbourRequirement(50_000_00, null, null, PACK_2026);
  assert.equal(first.required, 45_000_00, '90% of the current year');
  assert.equal(first.priorYearKnown, false);
});

test('the four instalments sum exactly to the requirement', () => {
  for (const liability of [10_000_00, 33_333_33, 1, 99_999_99]) {
    const schedule = buildRemittanceSchedule({ liability, withheld: 0, pack: PACK_2026 });
    const total = schedule.instalments.reduce((a, i) => a + i.amount, 0);
    assert.equal(total, schedule.estimatedPaid);
    assert.equal(schedule.instalments.length, 4);
  }
});

test('the year reconciles exactly: liability − withheld − instalments − true-up === 0', () => {
  // Invariant #10. This identity IS the reconciliation.
  for (const [liability, withheld, prior] of [
    [30_000_00, 0, null],
    [30_000_00, 25_000_00, 28_000_00],
    [30_000_00, 40_000_00, 28_000_00],   // over-withheld: a refund
    [0, 5_000_00, 1_000_00],
    [12_345_67, 6_789_01, 9_999_99],
  ]) {
    const schedule = buildRemittanceSchedule({
      liability, withheld, priorYearLiability: prior, priorYearAgi: 100_000_00, pack: PACK_2026,
    });
    assert.equal(
      reconcile({ liability, withheld, instalments: schedule.instalments, trueUp: schedule.trueUp }),
      0,
      `did not reconcile for liability ${liability} / withheld ${withheld}`,
    );
  }
});

test('over-withholding produces a refund, not a negative payment', () => {
  const schedule = buildRemittanceSchedule({
    liability: 20_000_00, withheld: 25_000_00, priorYearLiability: 19_000_00, pack: PACK_2026,
  });
  assert.equal(schedule.refund, 5_000_00);
  assert.equal(schedule.balanceDue, 0);
  assert.ok(schedule.trueUp.isRefund);
  assert.equal(schedule.estimatedPaid, 0, 'nothing needs paying in when withholding covers it');
});

test('a small balance below the filing threshold needs no estimated payments', () => {
  const schedule = buildRemittanceSchedule({
    liability: 20_500_00, withheld: 20_000_00, priorYearLiability: 20_000_00, pack: PACK_2026,
  });
  assert.equal(schedule.belowFilingThreshold, true, '$500 owed is under the $1,000 threshold');
  assert.equal(schedule.estimatedPaid, 0);
  assert.equal(schedule.balanceDue, 500_00, 'it is still owed in April');
});

/* ---- FICA is not an income-tax prepayment ---- */

test('employee FICA is not counted as income tax withholding', async () => {
  // The bug this guards: counting FICA toward the income tax bill inflated every refund by
  // the whole year's payroll tax. FICA is withheld and finished with — it does not settle
  // up on the return.
  const { runProjection } = await import('../model/engine.js');
  const { registerBuiltInCloseRules } = await import('../model/close-rules.js');
  const { resolveSources } = await import('../model/scenarios.js');
  const { simpleModel } = await import('./helpers/models.js');
  const { PACKS } = await import('./helpers/packs.js');

  try { registerBuiltInCloseRules(); } catch { /* already registered by another file */ }

  const run = runProjection({ ...simpleModel(), taxPacks: PACKS }, { resolveSources });
  const year = run.yearResults[2026];

  const ficaEvents = run.events.filter((e) => e.kind === 'withholding' && e.tags.includes('fica'));
  const ficaTotal = -ficaEvents.reduce((sum, e) => sum + e.cashAmount, 0);

  assert.ok(ficaTotal > 0, 'the fixture should withhold FICA');
  assert.equal(year.payrollTaxWithheld, ficaTotal, 'FICA is reported on its own');
  assert.ok(
    year.withheld < ficaTotal + year.withheld,
    'income tax withholding must exclude FICA',
  );

  const incomeTaxEvents = run.events.filter(
    (e) => e.kind === 'withholding' && e.tags.includes('income-tax'),
  );
  assert.equal(
    year.withheld,
    -incomeTaxEvents.reduce((sum, e) => sum + e.cashAmount, 0),
    'the reconciliation counts income tax withholding and nothing else',
  );

  // And the two are genuinely disjoint.
  assert.equal(
    ficaEvents.filter((e) => e.tags.includes('income-tax')).length, 0,
    'an event must not be both',
  );
});

/* ---- capital gains: preferential rates, stacked ---- */

test('the 0% capital-gains band is used up by ordinary income, not reserved for gains', async () => {
  // The misconception this guards: "the first $49,450 of gains are tax-free". They are
  // free only while TOTAL taxable income stays under that figure.
  const { preferentialTax } = await import('../model/tax/rule-pack.js');
  const cg = PACK_2026.capitalGainsBrackets.single;

  // No other income: the whole gain sits in the 0% band.
  const alone = preferentialTax(0, 40_000_00, cg);
  assert.equal(alone.tax, 0);

  // $60,000 of ordinary income has already consumed the 0% band, so the first dollar of
  // gain is taxed at 15%.
  const stacked = preferentialTax(60_000_00, 40_000_00, cg);
  assert.equal(stacked.tax, 6_000_00, '15% of the whole $40,000');

  // Straddling the boundary: $30,000 ordinary leaves $19,450 of the 0% band.
  const straddle = preferentialTax(30_000_00, 40_000_00, cg);
  assert.equal(straddle.tax, scaleCentsLocal(40_000_00 - 19_450_00, 0.15));
  assert.deepEqual(straddle.bands.map((b) => b.rate), [0, 0.15]);
});

function scaleCentsLocal(cents, rate) {
  return Math.round(cents * rate);
}

test('a long-term gain is taxed at preferential rates, not ordinary ones', () => {
  const wagesOnly = computeFederal(book({ w2_wages: 80_000_00 }), SINGLE, PACK_2026);
  const withGain = computeFederal(
    book({ w2_wages: 80_000_00, long_term_gains: 20_000_00 }), SINGLE, PACK_2026,
  );

  const extraTax = withGain.totalLiability - wagesOnly.totalLiability;
  assert.equal(extraTax, 3_000_00, '15% of $20,000, not the 22% ordinary rate');

  assert.equal(withGain.preferentialTaxable, 20_000_00);
  assert.equal(withGain.ordinaryTaxable, 80_000_00 - 16_100_00);
  assert.equal(withGain.capitalGainsTax, 3_000_00);
  assert.ok(!withGain.warnings.some((w) => w.code === 'tax.preferential_not_modeled'),
    'capital gains are modelled now, so the caveat should be gone');
});

test('a short-term gain gets no preferential treatment', () => {
  const long = computeFederal(book({ w2_wages: 80_000_00, long_term_gains: 20_000_00 }), SINGLE, PACK_2026);
  const short = computeFederal(book({ w2_wages: 80_000_00, short_term_gains: 20_000_00 }), SINGLE, PACK_2026);

  assert.ok(short.totalLiability > long.totalLiability,
    'selling within a year costs more');
  assert.equal(short.preferentialTaxable, 0);
  assert.equal(short.capitalGainsTax, 0);
});

test('qualified dividends are preferential; ordinary dividends are not', () => {
  const qualified = computeFederal(book({ w2_wages: 80_000_00, qualified_dividends: 10_000_00 }), SINGLE, PACK_2026);
  const ordinary = computeFederal(book({ w2_wages: 80_000_00, ordinary_dividends: 10_000_00 }), SINGLE, PACK_2026);

  assert.equal(qualified.capitalGainsTax, 1_500_00, '15%');
  assert.ok(ordinary.totalLiability > qualified.totalLiability);
});

test('a gain crossing into the 20% band is split across the bands', () => {
  // Single: 0% to $49,450, 15% to $545,500, 20% above.
  const result = computeFederal(
    book({ w2_wages: 500_000_00, long_term_gains: 100_000_00 }), SINGLE, PACK_2026,
  );

  const rates = result.capitalGainsBands.map((b) => b.rate);
  assert.deepEqual(rates, [0.15, 0.20], 'the gain straddles the 15% and 20% bands');
  assert.equal(
    result.capitalGainsBands.reduce((sum, b) => sum + b.amount, 0),
    100_000_00,
    'every dollar of the gain lands in exactly one band',
  );
});

test('a gain below the deduction is not taxed at all', () => {
  const result = computeFederal(book({ long_term_gains: 10_000_00 }), SINGLE, PACK_2026);
  assert.equal(result.taxableIncome, 0, 'the standard deduction covers it');
  assert.equal(result.totalLiability, 0);
});

test('preferential income is capped at taxable income after deductions', () => {
  // $20,000 of gains against a $16,100 deduction and no other income leaves $3,900 taxable.
  const result = computeFederal(book({ long_term_gains: 20_000_00 }), SINGLE, PACK_2026);
  assert.equal(result.taxableIncome, 3_900_00);
  assert.equal(result.preferentialTaxable, 3_900_00, 'not the full $20,000');
  assert.equal(result.capitalGainsTax, 0, 'and it sits inside the 0% band');
});

/* ---- QBI (§199A) ---- */

test('QBI gives 20% of business income to a modest sole trader', async () => {
  const { computeQbi } = await import('../model/tax/qbi.js');

  const result = computeQbi({
    qbi: 80_000_00, taxableIncome: 90_000_00, netCapitalGain: 0,
    isSSTB: false, filingStatus: 'single', pack: PACK_2026,
  });

  assert.equal(result.deduction, 16_000_00, '20% of $80,000');
  assert.equal(result.limitedBy, 'qbi');
  assert.equal(result.phaseOutFraction, 0, 'well below the threshold');
});

test('QBI is capped by taxable income excluding capital gain', async () => {
  const { computeQbi } = await import('../model/tax/qbi.js');

  // A large gain inflates taxable income but must not inflate the deduction.
  const result = computeQbi({
    qbi: 80_000_00, taxableIncome: 150_000_00, netCapitalGain: 120_000_00,
    isSSTB: false, filingStatus: 'single', pack: PACK_2026,
  });

  assert.equal(result.deduction, 6_000_00, '20% of the $30,000 that is not capital gain');
  assert.equal(result.limitedBy, 'taxable-income');
});

test('a service business loses the deduction across the phase-out range', async () => {
  const { computeQbi } = await import('../model/tax/qbi.js');
  const args = { qbi: 100_000_00, netCapitalGain: 0, isSSTB: true, filingStatus: 'single', pack: PACK_2026 };

  // Threshold $201,750, top of range $276,750 — a $75,000 span.
  const below = computeQbi({ ...args, taxableIncome: 190_000_00 });
  assert.equal(below.deduction, 20_000_00, 'below the threshold, no phase-out');

  const halfway = computeQbi({ ...args, taxableIncome: 239_250_00 });
  assert.equal(halfway.phaseOutFraction, 0.5);
  assert.equal(halfway.deduction, 10_000_00, 'half the deduction remains');

  const above = computeQbi({ ...args, taxableIncome: 300_000_00 });
  assert.equal(above.deduction, 0, 'a service business gets nothing above the range');
  assert.ok(above.warnings.some((w) => w.code === 'qbi.sstb_phased_out'));
});

test('a non-service business above the threshold is flagged as possibly overstated', async () => {
  const { computeQbi } = await import('../model/tax/qbi.js');

  const result = computeQbi({
    qbi: 300_000_00, taxableIncome: 400_000_00, netCapitalGain: 0,
    isSSTB: false, filingStatus: 'single', pack: PACK_2026,
  });

  assert.ok(result.deduction > 0, 'a non-service business keeps the deduction');
  assert.ok(
    result.warnings.some((w) => w.code === 'qbi.above_threshold_unlimited'),
    'but the wage and property caps are not modelled, and the user must be told',
  );
});

test('the QBI thresholds match Rev. Proc. 2025-32', () => {
  assert.equal(PACK_2026.qbi.threshold.married_joint, 403_500_00);
  assert.equal(PACK_2026.qbi.threshold.married_separate, 201_775_00);
  assert.equal(PACK_2026.qbi.threshold.single, 201_750_00);
  assert.equal(PACK_2026.qbi.phaseInTop.married_joint, 553_500_00);
  assert.equal(PACK_2026.qbi.phaseInTop.single, 276_750_00);
  assert.equal(
    PACK_2026.qbi.threshold.head_of_household, PACK_2026.qbi.threshold.single,
    'head of household uses the "all other returns" figures',
  );
});

test('QBI flows through a real return and lowers the tax', () => {
  const withoutQbi = computeFederal(book({ w2_wages: 90_000_00 }), SINGLE, PACK_2026);
  const withQbi = computeFederal(book({ se_net_profit: 90_000_00 }), SINGLE, PACK_2026);

  assert.ok(withQbi.qbiDeduction > 0, 'self-employment income qualifies');
  assert.equal(withQbi.taxableIncome, withQbi.taxableIncomeBeforeQbi - withQbi.qbiDeduction);

  // Wages never qualify, however they are earned.
  assert.equal(withoutQbi.qbiDeduction, 0);
});

test('QBI is computed on business income net of the self-employment adjustment', () => {
  const result = computeFederal(book({ se_net_profit: 100_000_00 }), SINGLE, PACK_2026);
  const deductibleHalf = result.perPerson.p1.selfEmploymentTax.deductibleHalf;

  assert.ok(deductibleHalf > 0);
  assert.equal(
    result.qbi.fromQbi,
    Math.round((100_000_00 - deductibleHalf) * 0.20),
    'the QBI limb is 20% of profit less the deductible half of SE tax, not of gross profit',
  );

  // At this income the OTHER limb binds: 20% of taxable income is smaller, because the
  // standard deduction has already come off. Both are reported so the reason is visible.
  assert.equal(result.qbi.fromIncome, Math.round(result.taxableIncomeBeforeQbi * 0.20));
  assert.equal(result.qbiDeduction, Math.min(result.qbi.fromQbi, result.qbi.fromIncome));
  assert.equal(result.qbi.limitedBy, 'taxable-income');
});
