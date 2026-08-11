/**
 * Turning sources into events.
 *
 * `compileAll` is dispatch only — it owns no financial logic. Each source type's compiler
 * receives a context that deliberately exposes no running balances, no other sources and
 * no clock, which is what makes a compiler a pure function of one source and therefore
 * makes source order irrelevant to the result.
 *
 * Anything that needs a running balance is not a compiler. It is a close rule; see
 * `ledger.js`.
 */

import { makeEvent, sortEvents, validateGroup, assertUniqueIds } from './events.js';
import { getSourceType, hasSourceType } from './sources/index.js';
import { makeWarning } from './warnings.js';
import { isWithin, monthsInRange, isAfter } from './dates.js';
import * as helpers from './recurrence.js';

/** Build the horizon object every compiler reads. */
export function makeHorizon(startDate, endDate) {
  return Object.freeze({
    startDate,
    endDate,
    months: Object.freeze(monthsInRange(startDate, endDate)),
  });
}

/**
 * @param {Array} sources         resolved sources (scenario overrides already applied)
 * @param {Object} options
 * @param {Object} options.horizon
 * @param {Object} [options.household]
 * @param {Object} [options.assumptions]
 * @param {Object} [options.rules]     tax rule packs, for FICA rates during withholding
 * @returns {{events: Array, warnings: Array}}
 */
export function compileAll(sources, { horizon, household = null, assumptions = {}, rules = null } = {}) {
  const events = [];
  const warnings = [];

  // Auto-assign `seq` so two events from one source in the same (date, phase) cannot
  // collide. Compilers should not have to think about this.
  const seqCounter = new Map();

  for (const source of sources) {
    if (!source.enabled) continue;

    if (!hasSourceType(source.type)) {
      warnings.push(makeWarning('source.unknown_type',
        { sourceId: source.id, name: source.name, type: source.type }, source.id));
      continue;
    }

    const def = getSourceType(source.type);

    // Source-local integrity checks. These report; they never alter the data.
    for (const warning of def.check(source)) warnings.push(warning);

    if (source.endDate && isAfter(source.startDate, source.endDate)) {
      warnings.push(makeWarning('source.end_before_start',
        { name: source.name, startDate: source.startDate, endDate: source.endDate }, source.id));
      continue;
    }
    if (isAfter(source.startDate, horizon.endDate)) {
      warnings.push(makeWarning('source.starts_after_horizon',
        { name: source.name, startDate: source.startDate, horizonEnd: horizon.endDate }, source.id));
      continue;
    }

    const ctx = makeCompileContext({
      source, horizon, household, assumptions, rules, events, warnings, seqCounter,
    });

    def.compile(source, ctx);
  }

  const ordered = sortEvents(events);
  assertUniqueIds(ordered);
  return { events: ordered, warnings };
}

function makeCompileContext({ source, horizon, household, assumptions, rules, events, warnings, seqCounter }) {
  const warn = (code, data = {}) => {
    warnings.push(makeWarning(code, { name: source.name, ...data }, source.id));
  };

  // Keyed by SOURCE as well as date and phase. Sharing one counter across sources would
  // make each event's seq — and therefore its id — depend on which source happened to
  // compile first, which would silently break source-order independence.
  const nextSeq = (date, phase) => {
    const key = `${source.id}:${date}:${phase}`;
    const seq = seqCounter.get(key) ?? 0;
    seqCounter.set(key, seq + 1);
    return seq;
  };

  /**
   * Build and record one event.
   *
   * Events settling outside the horizon are dropped WITH A WARNING rather than silently.
   * That is the "payment lag extends beyond the projection" case: a December invoice on
   * net-60 terms is real money the user should know is not being counted.
   */
  const emit = (partial) => {
    const date = partial.date;

    if (!isWithin(date, horizon.startDate, horizon.endDate)) {
      warnings.push(makeWarning('horizon.event_dropped', {
        label: partial.label || source.name,
        date,
        horizonStart: horizon.startDate,
        horizonEnd: horizon.endDate,
      }, source.id));
      return null;
    }

    const event = makeEvent({
      sourceId: source.id,
      personId: source.personId ?? null,
      ...partial,
      // Assigned last so a compiler never has to track it, and cannot accidentally collide.
      seq: 'seq' in partial ? partial.seq : nextSeq(date, partial.phase),
    });
    events.push(event);
    return event;
  };

  /** Emit several legs of one transaction and check they balance. */
  const emitGroup = (groupId, partials) => {
    const emitted = [];
    for (const partial of partials) {
      const event = emit({ ...partial, groupId });
      if (event) emitted.push(event);
    }
    // Only validate when every leg survived; a partially-dropped group has already warned.
    if (emitted.length === partials.length) validateGroup(emitted);
    return emitted;
  };

  return Object.freeze({
    horizon,
    household,
    assumptions,
    rules,
    helpers,
    emit,
    emitGroup,
    warn,
    /** The window this source is actually active for, clipped to the horizon. */
    window: Object.freeze({
      start: source.startDate > horizon.startDate ? source.startDate : horizon.startDate,
      end: source.endDate && source.endDate < horizon.endDate ? source.endDate : horizon.endDate,
    }),
  });
}
