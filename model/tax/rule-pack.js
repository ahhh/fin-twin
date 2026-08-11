/**
 * Tax rule packs: loading, validating, selecting.
 *
 * Tax rules are DATA, never code. No bracket, limit or threshold may appear in a `.js`
 * file under `model/tax/` — `tests/no-hardcoded-tax.test.js` enforces that by grepping for
 * numeric literals. The rule is deliberately annoying: a hard-coded threshold is invisible
 * when the law changes, and the resulting answer stays confident and wrong.
 *
 * `bracketTax` is the only place brackets are read.
 */

import { assertCents, roundHalfAwayFromZero, scaleCents } from '../money.js';
import { isValidISO, todayISO } from '../dates.js';

/** The pack shape this engine understands. A pack declaring a higher api is refused. */
export const ENGINE_API = 1;

export class RulePackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RulePackError';
    this.code = code;
  }
}

const REQUIRED_TOP_LEVEL = [
  'packId', 'engineApi', 'taxYear', 'units', 'filingStatuses', 'standardDeduction',
  'ordinaryBrackets', 'payroll', 'selfEmployment', 'estimatedTax', 'contributionLimits',
  'lastVerified', 'sources',
];

/**
 * Validate a pack. Returns a list of problems; an empty list means it is usable.
 *
 * The most valuable check here is that every monetary value is a safe INTEGER. A standard
 * deduction typed as `16100` instead of `1610000` would otherwise sail through and produce
 * a plausible-looking answer that is wrong by two orders of magnitude.
 */
export function validatePack(pack) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (!pack || typeof pack !== 'object') return ['pack is not an object'];

  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in pack)) fail(`missing required key "${key}"`);
  }
  if (problems.length > 0) return problems;

  if (typeof pack.engineApi !== 'number' || pack.engineApi > ENGINE_API) {
    fail(`pack declares engineApi ${pack.engineApi}; this engine understands ${ENGINE_API}`);
  }
  if (pack.units !== 'cents') {
    fail(`pack units must be "cents", got "${pack.units}"`);
  }
  if (!isValidISO(pack.lastVerified)) {
    fail(`lastVerified "${pack.lastVerified}" is not a date`);
  } else if (pack.lastVerified > todayISO()) {
    fail(`lastVerified "${pack.lastVerified}" is in the future`);
  }
  if (!Array.isArray(pack.sources) || pack.sources.length === 0) {
    fail('a pack must cite at least one source');
  }

  const statuses = pack.filingStatuses;
  if (!Array.isArray(statuses) || statuses.length === 0) {
    fail('filingStatuses is empty');
    return problems;
  }

  for (const status of statuses) {
    if (!isCentsValue(pack.standardDeduction?.[status])) {
      fail(`standardDeduction.${status} is not an integer number of cents ` +
        `(got ${pack.standardDeduction?.[status]}) — dollars are a formatting concern`);
    }
    problems.push(...validateBracketTable(pack.ordinaryBrackets?.[status], `ordinaryBrackets.${status}`));
    if (pack.capitalGainsBrackets) {
      problems.push(...validateBracketTable(pack.capitalGainsBrackets[status], `capitalGainsBrackets.${status}`, { requireBase: false }));
    }
    const threshold = pack.payroll?.additionalMedicare?.threshold?.[status];
    if (!isCentsValue(threshold)) {
      fail(`payroll.additionalMedicare.threshold.${status} is not integer cents (got ${threshold})`);
    }
  }

  if (!isCentsValue(pack.payroll?.socialSecurity?.wageBase)) {
    fail('payroll.socialSecurity.wageBase is not integer cents');
  }
  for (const [path, value] of [
    ['payroll.socialSecurity.rateEmployee', pack.payroll?.socialSecurity?.rateEmployee],
    ['payroll.medicare.rateEmployee', pack.payroll?.medicare?.rateEmployee],
    ['selfEmployment.netEarningsFactor', pack.selfEmployment?.netEarningsFactor],
    ['selfEmployment.socialSecurityRate', pack.selfEmployment?.socialSecurityRate],
    ['selfEmployment.medicareRate', pack.selfEmployment?.medicareRate],
    ['selfEmployment.deductibleFraction', pack.selfEmployment?.deductibleFraction],
  ]) {
    if (typeof value !== 'number' || !(value > 0 && value <= 1)) {
      fail(`${path} must be a rate within (0, 1], got ${value}`);
    }
  }

  const est = pack.estimatedTax;
  if (!Array.isArray(est?.dueDates) || est.dueDates.length !== est?.installmentFractions?.length) {
    fail('estimatedTax.dueDates and installmentFractions must be the same length');
  } else {
    for (const date of est.dueDates) {
      if (!isValidISO(date)) fail(`estimatedTax due date "${date}" is not a date`);
    }
    const total = est.installmentFractions.reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 1e-9) fail(`estimatedTax.installmentFractions sum to ${total}, not 1`);
  }
  if (!isValidISO(est?.trueUpDate)) fail('estimatedTax.trueUpDate is not a date');
  if (!isCentsValue(est?.safeHarbor?.highIncomeAgiThreshold)) {
    fail('estimatedTax.safeHarbor.highIncomeAgiThreshold is not integer cents');
  }

  for (const [plan, limits] of Object.entries(pack.contributionLimits ?? {})) {
    for (const [name, value] of Object.entries(limits)) {
      if (!isCentsValue(value)) fail(`contributionLimits.${plan}.${name} is not integer cents (got ${value})`);
    }
  }

  return problems;
}

function isCentsValue(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Brackets must be ascending, contiguous and open-topped, and each `base` must follow from
 * the row before it — which is what lets the table be proof-read against the published one.
 */
function validateBracketTable(table, path, { requireBase = true } = {}) {
  const problems = [];
  if (!Array.isArray(table) || table.length === 0) return [`${path} is missing or empty`];

  let previousUpTo = 0;
  let expectedBase = 0;

  table.forEach((row, index) => {
    const last = index === table.length - 1;

    if (typeof row.rate !== 'number' || row.rate < 0 || row.rate >= 1) {
      problems.push(`${path}[${index}].rate is ${row.rate}; expected a fraction below 1`);
    }
    if (last) {
      if (row.upTo !== null) problems.push(`${path} must end with upTo: null (an open top bracket)`);
    } else {
      if (!isCentsValue(row.upTo)) {
        problems.push(`${path}[${index}].upTo is not integer cents (got ${row.upTo})`);
      } else if (row.upTo <= previousUpTo) {
        problems.push(`${path}[${index}].upTo (${row.upTo}) does not exceed the previous threshold (${previousUpTo})`);
      }
    }

    if (requireBase) {
      if (!isCentsValue(row.base)) {
        problems.push(`${path}[${index}].base is not integer cents (got ${row.base})`);
      } else if (row.base !== expectedBase) {
        problems.push(
          `${path}[${index}].base is ${row.base} but the rows above it accumulate to ${expectedBase}. ` +
          'Either a threshold or a base was mistyped.',
        );
      }
      if (!last && isCentsValue(row.upTo)) {
        expectedBase = roundHalfAwayFromZero(expectedBase + row.rate * (row.upTo - previousUpTo));
      }
    }

    if (!last) previousUpTo = row.upTo;
  });

  return problems;
}

/** Validate and freeze, or throw with every problem listed at once. */
export function assertValidPack(pack) {
  const problems = validatePack(pack);
  if (problems.length > 0) {
    throw new RulePackError('tax.invalid_pack',
      `tax rule pack "${pack?.packId ?? '?'}" is invalid:\n  - ${problems.join('\n  - ')}`);
  }
  return Object.freeze(pack);
}

/**
 * Fetch a pack. The one place in the model allowed to touch the network API, and it only
 * ever reaches same-origin static JSON.
 */
export async function loadRulePack(year, { country = 'us', level = 'federal', baseUrl = 'data/tax' } = {}) {
  const url = `${baseUrl}/${country}/${level}/${year}.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new RulePackError('tax.pack_not_found', `no rule pack at ${url} (${response.status})`);
  }
  return assertValidPack(await response.json());
}

/**
 * Pick the pack for a tax year.
 *
 * A year with no pack does NOT silently reuse last year's brackets. It carries the newest
 * earlier pack forward, marks the result `extrapolated`, and the UI renders those years
 * differently with a footnote saying so.
 */
export function selectPackForYear(packs, year) {
  const exact = packs.find((p) => p.taxYear === year);
  if (exact) return { pack: exact, extrapolated: false, usedYear: year };

  const earlier = packs.filter((p) => p.taxYear < year).sort((a, b) => b.taxYear - a.taxYear)[0];
  if (earlier) return { pack: earlier, extrapolated: true, usedYear: earlier.taxYear };

  const later = packs.slice().sort((a, b) => a.taxYear - b.taxYear)[0];
  if (later) return { pack: later, extrapolated: true, usedYear: later.taxYear };

  throw new RulePackError('tax.no_packs', 'no tax rule packs are loaded at all');
}

/**
 * Tax on an amount, given a bracket table. The ONLY place brackets are read.
 *
 * Uses the published `base + rate x excess` form so the computation mirrors the table
 * exactly rather than re-deriving it.
 */
export function bracketTax(taxableCents, brackets) {
  assertCents(taxableCents, 'taxable income');
  if (taxableCents <= 0) return 0;

  let floor = 0;
  for (const row of brackets) {
    if (row.upTo === null || taxableCents <= row.upTo) {
      return scaleCents(taxableCents - floor, row.rate) + (row.base ?? 0);
    }
    floor = row.upTo;
  }
  throw new RulePackError('tax.bracket_table_open', 'bracket table did not terminate with upTo: null');
}

/**
 * Tax on preferential income (long-term gains, qualified dividends), STACKED on top of
 * ordinary income.
 *
 * This is the part people get wrong. The 0% capital-gains band is not "the first $49,450
 * of gains are free" — it is "gains are free only to the extent your total taxable income
 * stays under $49,450". Someone with $60,000 of ordinary income pays 15% on their first
 * dollar of gain, because the 0% band is already used up.
 *
 * So each band is filled from `ordinaryTaxable` upward, not from zero.
 *
 * @param {number} ordinaryTaxable   taxable income excluding preferential income
 * @param {number} preferential      the preferential income itself
 * @param {Array}  brackets          the pack's capital-gains table
 */
export function preferentialTax(ordinaryTaxable, preferential, brackets) {
  assertCents(ordinaryTaxable, 'ordinary taxable income');
  assertCents(preferential, 'preferential income');
  if (preferential <= 0) return { tax: 0, bands: [] };

  const floor = Math.max(0, ordinaryTaxable);
  const ceiling = floor + preferential;

  let tax = 0;
  let previousTop = 0;
  const bands = [];

  for (const row of brackets) {
    const top = row.upTo === null ? Infinity : row.upTo;

    // How much of the preferential income falls inside this band.
    const from = Math.max(floor, previousTop);
    const to = Math.min(ceiling, top);
    const amount = Math.max(0, to - from);

    if (amount > 0) {
      const bandTax = scaleCents(amount, row.rate);
      tax += bandTax;
      bands.push({ rate: row.rate, amount, tax: bandTax });
    }

    previousTop = top;
    if (top >= ceiling) break;
  }

  return { tax, bands };
}

/** The rate the next dollar would be taxed at, by table lookup. See federal.js for why
 *  the reported marginal rate is measured by probe instead. */
export function statutoryBracketRate(taxableCents, brackets) {
  for (const row of brackets) {
    if (row.upTo === null || taxableCents <= row.upTo) return row.rate;
  }
  return brackets[brackets.length - 1].rate;
}

/** A one-line provenance string for the UI: "US Federal 2026 — verified 2026-08-11". */
export function packLabel(pack) {
  const jurisdiction = pack.jurisdiction
    ? `${pack.jurisdiction.country.toUpperCase()} ${pack.jurisdiction.level[0].toUpperCase()}${pack.jurisdiction.level.slice(1)}`
    : pack.packId;
  return `${jurisdiction} ${pack.taxYear} — verified ${pack.lastVerified}`;
}
