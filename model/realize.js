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

/** True when this event's amount depends on something that might not happen. */
export const isUncertain = (event) => event.probability < 1;

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
    if (!isUncertain(event)) {
      out.push(event);
      continue;
    }

    switch (mode) {
      case 'certain':
      case 'won':
      case 'high':
        // It happens, in full.
        out.push(withEvent(event, { probability: 1, realization: 'won' }));
        break;

      case 'lost':
      case 'low':
        // It does not happen. The event is OMITTED rather than zeroed, so tables and
        // charts do not fill up with rows worth nothing.
        omitted.add(event.sourceId);
        break;

      case 'expected':
      case 'base': {
        const cashAmount = scaleCents(event.cashAmount, event.probability);
        const taxableAmount = scaleCents(event.taxableAmount, event.probability);
        // Scaling can round a small amount to zero, which would break the
        // taxable/taxCategory coupling. Drop the event instead of emitting an invalid one.
        if (cashAmount === 0 && taxableAmount === 0) {
          omitted.add(event.sourceId);
          break;
        }
        out.push(withEvent(event, {
          cashAmount,
          taxableAmount,
          taxCategory: taxableAmount === 0 ? null : event.taxCategory,
          taxYear: taxableAmount === 0 ? null : event.taxYear,
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
