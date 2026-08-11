/**
 * The projection orchestrator.
 *
 * Deliberately thin — it sequences the passes and owns no financial logic, so the whole
 * shape of a run fits on one screen.
 *
 * The two-pass structure resolves what looks like a circularity: estimated tax payments
 * are cash events inside the year, but their size depends on the year's income. It works
 * because the entire future is compiled before any cash walks, so pass A can read the
 * whole taxable book without knowing a single balance.
 *
 *   PASS A (tax)   reads events, never a balance     -> tax events
 *   PASS B (cash)  reads events, never taxable income -> balances, months, minimum cash
 *
 * They touch at withholding events (made in compile, consumed by pass A), tax events (made
 * by pass A, consumed by pass B), and the tax-reserve close rule (pass B, reading pass A's
 * results read-only).
 *
 * That much is a clean two-pass pipeline. But some money genuinely IS produced during the
 * cash walk and IS taxable — savings interest is the everyday case, since it depends on a
 * running balance that pass A never sees. So the two passes are run in a loop until the
 * liability stops moving. Models with nothing feeding back settle on the first pass and
 * pay nothing for the machinery; models that do feed back get an answer that is actually
 * consistent rather than one pass stale. Failing to converge is an error, not a shrug.
 */

import { compileAll, makeHorizon } from './compile.js';
import { realize } from './realize.js';
import { close } from './ledger.js';
import { accumulateTaxable, sortEvents } from './events.js';
import { runKeyFor } from './hash.js';
import { addYears, todayISO } from './dates.js';
import { sortWarnings } from './warnings.js';
import { taxPass } from './tax/index.js';
import { computeMetrics } from './metrics.js';
import { accountMap, balanceSheet, liquidAccountsFrom, openingBalancesFrom } from './accounts.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export const DEFAULT_HORIZON_YEARS = 5;

/**
 * How many times the tax and cash passes may chase each other before we give up.
 *
 * Four is generous: savings interest converges in two, because the second pass changes the
 * tax bill by a few dollars and the third would change it by pennies.
 */
export const DEFAULT_MAX_ITERATIONS = 4;

/** Below a dollar of movement, the passes have settled. */
const CONVERGENCE_CENTS = 100;

const totalLiabilityOf = (yearResults) =>
  Object.values(yearResults).reduce((sum, r) => sum + (r.totalLiability ?? 0), 0);

const accountMapFor = (model) => accountMap(model.accounts ?? []);
const openingBalancesFor = (model, accounts) => openingBalancesFrom(model, accounts);
const liquidAccountsFor = (model, accounts) => liquidAccountsFrom(model, accounts);

/**
 * Build a horizon from a model, defaulting to five years from the model's start date.
 * The clock is read only here and only when the model does not say — a projection is
 * otherwise a pure function of its inputs, which is what makes runs reproducible.
 */
export function horizonFor(model) {
  const start = model.horizon?.startDate ?? model.startDate ?? todayISO();
  const end = model.horizon?.endDate ?? addYears(start, model.horizon?.years ?? DEFAULT_HORIZON_YEARS);
  return makeHorizon(start, end);
}

/**
 * Run a projection.
 *
 * @param {Object} model
 * @param {Object} [options]
 * @param {string} [options.scenarioId='base']
 * @param {string} [options.mode='expected']  realisation mode
 * @param {Object} [options.horizon]
 * @param {Function} [options.resolveSources] injected so engine.js does not depend on
 *                                            scenarios.js; defaults to "use the model".
 * @param {number} [options.maxIterations=1]
 * @returns {Object} Run
 */
export function runProjection(model, options = {}) {
  const {
    scenarioId = 'base',
    mode = 'expected',
    resolveSources = defaultResolveSources,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = options;

  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new EngineError('engine.bad_iterations',
      `maxIterations must be a positive integer, got ${maxIterations}`);
  }

  const horizon = options.horizon ?? horizonFor(model);
  const warnings = [];

  /* 1-2. Resolve sources for the scenario, then substitute assumptions. */
  const resolved = resolveSources(model, scenarioId);
  warnings.push(...resolved.warnings);

  /* 3. Compile every source into events. */
  const compiled = compileAll(resolved.sources, {
    horizon,
    household: model.household ?? null,
    assumptions: model.assumptions ?? {},
    rules: model.rules ?? null,
  });
  warnings.push(...compiled.warnings);

  /* 4-5. Realise the uncertainty, then order. */
  const realised = realize(compiled.events, mode);
  const events = sortEvents(realised.events);

  const packs = options.packs ?? model.taxPacks ?? [];
  const accounts = accountMapFor(model);

  /* ---- The two passes, iterated to a fixed point ----
   *
   * Most models settle on the first pass: nothing in the cash walk feeds taxable income,
   * so `feedback` stays empty and the loop runs once. It runs again only when a close rule
   * produced taxable income — savings interest, typically — in which case pass A has to be
   * redone knowing about it. Converged means the total liability stopped moving by less
   * than a dollar.
   */
  let feedback = [];      // taxable events produced by pass B, fed back into pass A
  let taxEvents = [];
  let yearResults = {};
  let ledger = null;
  let book = {};
  let iterations = 0;
  let converged = false;
  let previousLiability = null;

  while (iterations < maxIterations) {
    iterations += 1;
    const passWarnings = [];

    /* ---- PASS A: tax. Reads events; never reads a balance. ---- */
    book = accumulateTaxable([...events, ...feedback]);

    taxEvents = [];
    yearResults = {};

    if (packs.length > 0) {
      const pass = taxPass({
        book,
        events: [...events, ...feedback],
        packs,
        statePacks: options.statePacks ?? model.stateTaxPacks ?? [],
        household: model.household ?? { filingStatus: 'single', people: [] },
        horizon,
        priorYear: model.priorYear ?? null,
      });
      taxEvents = pass.taxEvents;
      yearResults = pass.yearResults;
      passWarnings.push(...pass.warnings);

      // E[tax(X)] is not tax(E[X]). When uncertain income has been blended into an
      // expected value, the resulting liability corresponds to no possible world — it sits
      // between the won and lost outcomes without being either. Flag it so the UI can say
      // so rather than presenting it as the tax figure.
      if (mode === 'expected' && realised.uncertainSourceIds.length > 0) {
        for (const year of Object.keys(yearResults)) {
          yearResults[year] = { ...yearResults[year], blendedApproximation: true };
        }
      }
    }

    /* ---- PASS B: cash. ---- */
    ledger = close(sortEvents([...events, ...taxEvents]), {
      openingBalances: openingBalancesFor(model, accounts),
      horizon,
      liquidAccounts: liquidAccountsFor(model, accounts),
      context: {
        accounts,
        taxReserveRate: model.taxReserveRate ?? 0,
        useProjectedTaxRate: model.useProjectedTaxRate ?? false,
        emergencyTargetMonths: model.emergencyTargetMonths ?? 3,
        emergencyWarned: new Set(),
        yearResults,
      },
    });
    passWarnings.push(...ledger.warnings);

    const liability = totalLiabilityOf(yearResults);
    converged =
      ledger.taxableFromCloseRules.length === 0 ||
      (previousLiability !== null && Math.abs(liability - previousLiability) < CONVERGENCE_CENTS);
    previousLiability = liability;

    if (converged) {
      warnings.push(...passWarnings);
      break;
    }

    // Another pass is needed. Discard this iteration's warnings so they are not reported
    // twice, and carry the newly-taxable events into the next pass A.
    feedback = ledger.taxableFromCloseRules;
  }

  if (!converged) {
    throw new EngineError('engine.did_not_converge',
      `the projection did not settle after ${maxIterations} passes: money produced during ` +
      'the cash walk keeps changing the tax bill, which changes the cash walk. Rather than ' +
      'show a figure that is one pass stale, this is an error. Raise maxIterations, or ' +
      'simplify whatever is feeding back.');
  }

  const finalEvents = sortEvents([...events, ...taxEvents, ...ledger.emitted]);

  const draft = {
    events: finalEvents,
    months: ledger.months,
    balances: ledger.balances,
    minLiquid: ledger.minLiquid,
    yearResults,
    liquidAccounts: model.liquidAccounts ?? undefined,
    sourcesResolved: resolved.sources,
    uncertainSourceIds: realised.uncertainSourceIds,
  };
  const metrics = computeMetrics(draft, {
    emergencyTargetMonths: model.emergencyTargetMonths ?? 3,
  });

  return Object.freeze({
    runKey: runKeyFor(finalEvents),
    scenarioId,
    mode,
    horizon,
    events: finalEvents,
    months: ledger.months,
    balances: ledger.balances,
    minLiquid: ledger.minLiquid,
    book,
    yearResults,
    metrics,
    accounts,
    balanceSheet: balanceSheet(ledger.balances, accounts),
    liquidAccounts: liquidAccountsFor(model, accounts),
    iterations,
    warnings: sortWarnings(warnings),
    overrideReport: resolved.report ?? [],
    sourcesResolved: resolved.sources,
    omittedSourceIds: realised.omittedSourceIds,
    uncertainSourceIds: realised.uncertainSourceIds,
  });
}

/** Base behaviour when no scenario system is wired in: use the model as written. */
function defaultResolveSources(model, scenarioId) {
  if (scenarioId !== 'base') {
    throw new EngineError('engine.no_scenario_resolver',
      `runProjection was asked for scenario "${scenarioId}" but no resolveSources was supplied`);
  }
  return { sources: model.sources ?? [], report: [], warnings: [] };
}

/** Run the same model under several realisation modes — the won / expected / lost strip. */
export function runComparison(model, modes, options = {}) {
  const out = new Map();
  for (const mode of modes) out.set(mode, runProjection(model, { ...options, mode }));
  return out;
}
