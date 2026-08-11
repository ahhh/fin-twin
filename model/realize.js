/**
 * The uncertainty seam.
 *
 * Compilers emit the FULL amount with a `probability` attached. This module turns one
 * compiled stream into a particular view of the future. That split is what makes the same
 * compilation serve every mode, and what lets Phase 6 add Monte Carlo without touching a
 * single compiler, the event contract, or the ledger:
 *
 *     realize(events, 'expected')          today
 *     realize(events, {sample: rng})       Phase 6 — run N times, aggregate the Runs
 *
 * The run is the unit of uncertainty, not the event.
 *
 * A note on why the UI never shows the expected-value run alone: a 50% chance of $100k is
 * not the same liquidity experience as $50k. One of those pays the mortgage in March and
 * the other does not. `lost` is the run that answers "what if this does not land", and it
 * is the one worth looking at first.
 *
 * TWO KINDS OF UNCERTAINTY, and they compose:
 *
 *   probability — WHETHER it happens. A contract either lands or it does not.
 *   range       — HOW MUCH it is. A royalty statement always arrives; what it says varies.
 *
 * A range rides on `meta.range = {low, base, high}` in absolute cents for that occurrence,
 * rather than on new event fields, because the event field list is frozen (see types.js).
 * The compiler emits the BASE amount and carries the other two alongside, for the same
 * reason it never pre-multiplies a probability: one compiled stream has to serve every run.
 *
 * Ranged events are never omitted. "The book sold badly" is a smaller cheque, not an
 * absent one, and zeroing it would overstate the downside of the very thing the range
 * exists to describe.
 */

import { scaleCents } from './money.js';
import { withEvent } from './events.js';

export class RealizeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RealizeError';
    this.code = code;
  }
}

export const MODES = Object.freeze(['certain', 'won', 'expected', 'lost', 'low', 'base', 'high']);

/**
 * Which end of a range each mode asks for.
 *
 * `certain` is deliberately absent: it means "ignore uncertainty", so a ranged event keeps
 * the base amount the compiler emitted.
 */
const RANGE_PICK = Object.freeze({
  won: 'high', high: 'high',
  expected: 'base', base: 'base',
  lost: 'low', low: 'low',
});

/**
 * The `{low, base, high}` triple an event carries, or null if it has none.
 *
 * Read defensively — `meta` is free-form, so a source could put anything under `range`.
 * A malformed triple is treated as no range rather than throwing: this is user data
 * arriving through a compiler, and the engine reports rather than repairs.
 */
export function rangeOf(event) {
  const range = event.meta?.range;
  if (!range) return null;
  const { low, base, high } = range;
  if (!Number.isInteger(low) || !Number.isInteger(base) || !Number.isInteger(high)) return null;
  return { low, base, high };
}

/**
 * True when this event's amount depends on something not yet known — either because it
 * might not happen at all (`probability`) or because its size varies (`meta.range`).
 *
 * Both count, because both are reasons the three-run comparison is worth showing.
 */
export const isUncertain = (event) => event.probability < 1 || rangeOf(event) !== null;

/**
 * @param {Array} events  compiled events
 * @param {string} mode   one of MODES
 * @returns {{events: Array, mode: string, omittedSourceIds: string[], uncertainSourceIds: string[]}}
 */
export function realize(events, mode = 'expected') {
  if (!MODES.includes(mode)) {
    throw new RealizeError('realize.bad_mode',
      `unknown realisation mode "${mode}" (expected one of ${MODES.join(', ')})`);
  }

  const uncertainSourceIds = [...new Set(events.filter(isUncertain).map((e) => e.sourceId))].sort();

  // Nothing uncertain: every mode collapses to the same stream. Returning the input
  // unchanged keeps run keys identical across modes for a certain model, which is what
  // makes "this model has no uncertainty" visible rather than implied.
  if (uncertainSourceIds.length === 0) {
    return { events, mode, omittedSourceIds: [], uncertainSourceIds: [] };
  }

  const out = [];
  const omitted = new Set();

  for (const event of events) {
    const range = rangeOf(event);
    if (!range && event.probability === 1) {
      out.push(event);
      continue;
    }

    // Range first, probability second, because they answer different questions and both
    // can apply to one event: a book deal that might not be signed AND whose royalties
    // are a guess is 60% likely to pay somewhere between low and high.
    const sized = range ? resize(event, range, mode) : event;

    if (sized.probability === 1) {
      out.push(sized);
      continue;
    }

    switch (mode) {
      case 'certain':
      case 'won':
      case 'high':
        // It happens, in full.
        out.push(withEvent(sized, { probability: 1, realization: 'won' }));
        break;

      case 'lost':
      case 'low':
        // It does not happen. The event is OMITTED rather than zeroed, so tables and
        // charts do not fill up with rows worth nothing.
        omitted.add(event.sourceId);
        break;

      case 'expected':
      case 'base': {
        const cashAmount = scaleCents(sized.cashAmount, sized.probability);
        const taxableAmount = scaleCents(sized.taxableAmount, sized.probability);
        // Scaling can round a small amount to zero, which would break the
        // taxable/taxCategory coupling. Drop the event instead of emitting an invalid one.
        if (cashAmount === 0 && taxableAmount === 0) {
          omitted.add(event.sourceId);
          break;
        }
        out.push(withEvent(sized, {
          cashAmount,
          taxableAmount,
          taxCategory: taxableAmount === 0 ? null : sized.taxCategory,
          taxYear: taxableAmount === 0 ? null : sized.taxYear,
          realization: 'expected',
        }));
        break;
      }

      default:
        throw new RealizeError('realize.unhandled_mode', `mode "${mode}" is not implemented`);
    }
  }

  return {
    events: out,
    mode,
    omittedSourceIds: [...omitted].sort(),
    uncertainSourceIds,
  };
}

/**
 * Restate an event at the low, base or high end of its range.
 *
 * `realization` is set to won / expected / lost the same way a probability would set it.
 * For a range those words mean "the good, middle and bad cheque" rather than whether the
 * money arrives at all — which is the honest reading of a run named "if it does not land"
 * when what varies is the size, not the existence.
 *
 * Taxable income follows cash in proportion rather than being taken from the range, so a
 * tax-free source stays tax-free and a partly-taxable one keeps its split.
 */
function resize(event, range, mode) {
  const cashAmount = range[RANGE_PICK[mode] ?? 'base'];
  if (cashAmount === event.cashAmount) return event;

  const taxableAmount = event.taxableAmount === event.cashAmount
    ? cashAmount
    : (event.cashAmount === 0
      ? event.taxableAmount
      : scaleCents(event.taxableAmount, cashAmount / event.cashAmount));

  return withEvent(event, {
    cashAmount,
    taxableAmount,
    taxCategory: taxableAmount === 0 ? null : event.taxCategory,
    taxYear: taxableAmount === 0 ? null : event.taxYear,
    realization: mode === 'won' || mode === 'high' ? 'won'
      : mode === 'lost' || mode === 'low' ? 'lost'
      : 'expected',
  });
}

/**
 * The three runs a user should see together for an uncertain model.
 *
 * Deliberately not "the" answer plus two footnotes — the point is that they are different
 * futures, and the gap between them is the information.
 */
export const COMPARISON_MODES = Object.freeze(['won', 'expected', 'lost']);

/** Does this stream contain anything uncertain at all? */
export function hasUncertainty(events) {
  return events.some(isUncertain);
}
