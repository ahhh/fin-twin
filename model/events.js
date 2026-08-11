/**
 * The normalised event: construction, validation, ordering and rollups.
 *
 * See `types.js` for the contract and the reasoning behind it. This module enforces it.
 * Validation throws rather than warns: a malformed event is a programming error in a
 * compiler, not a problem with the user's data. User-data problems become `Warning`s.
 */

import { assertCents, isCents, sumCents } from './money.js';
import { isValidISO, isWithin, toPeriod, yearOf } from './dates.js';

export class EventError extends Error {
  constructor(code, message, event) {
    super(message);
    this.name = 'EventError';
    this.code = code;
    this.event = event;
  }
}

export const EVENT_KINDS = Object.freeze([
  'income', 'expense', 'transfer', 'contribution', 'withholding',
  'tax_payment', 'tax_refund', 'debt_service', 'growth', 'noncash', 'adjustment',
]);

/**
 * Intra-month ordering. See the note in types.js: this affects minimum intra-month cash
 * and close rules, NOT closing balances. Do not reorder to "fix" a total.
 */
export const PHASES = Object.freeze([
  'OPEN',
  'INCOME_GROSS',
  'PRETAX_DEDUCTION',   // above WITHHOLDING on purpose: withholding is computed net of it
  'WITHHOLDING',
  'EXPENSE',
  'DEBT_SERVICE',
  'POSTTAX_CONTRIBUTION',
  'TRANSFER',
  'ESTIMATED_TAX',
  'TAX_TRUE_UP',
  'GROWTH',
  'CLOSE',
]);

export const PHASE_ORDER = Object.freeze(
  Object.fromEntries(PHASES.map((phase, index) => [phase, index])),
);

export const TAX_CATEGORIES = Object.freeze([
  'w2_wages', 'se_net_profit', 'interest', 'ordinary_dividends', 'qualified_dividends',
  'short_term_gains', 'long_term_gains', 'rental_net', 'retirement_distribution_ordinary',
  'tax_exempt_interest', 'other_ordinary', 'pretax_deferral', 'above_line_deduction',
]);

/** Categories whose taxable amounts are negative by nature. */
export const NEGATIVE_TAX_CATEGORIES = Object.freeze(['pretax_deferral', 'above_line_deduction']);

export const REALIZATIONS = Object.freeze(['certain', 'expected', 'won', 'lost']);

/**
 * The exact key set of every event. Frozen deliberately — see the "why the event field
 * list is frozen" section of types.js. `tests/event-shape.test.js` asserts against this.
 */
export const EVENT_FIELDS = Object.freeze([
  'account', 'cashAmount', 'category', 'cutPriority', 'date', 'essential', 'groupId', 'id',
  'kind', 'label', 'meta', 'period', 'personId', 'phase', 'probability', 'realization',
  'seq', 'sourceId', 'tags', 'taxCategory', 'taxYear', 'taxableAmount',
]);

const KIND_SET = new Set(EVENT_KINDS);
const PHASE_SET = new Set(PHASES);
const TAX_CATEGORY_SET = new Set(TAX_CATEGORIES);
const REALIZATION_SET = new Set(REALIZATIONS);

/** Build the deterministic id for an event. */
export function eventId({ sourceId, date, phase, seq }) {
  return `${sourceId}:${date}:${phase}:${seq}`;
}

function fail(code, message, event) {
  throw new EventError(code, message, event);
}

/**
 * Validate the invariants an event can satisfy on its own.
 *
 * Cross-event invariants — unique ids, transfer legs summing to zero, horizon containment —
 * live in `validateGroup`, `assertUniqueIds` and `assertWithinHorizon`, because a single
 * event cannot know about them.
 */
export function validateEvent(event) {
  const at = () => `${event.sourceId ?? '?'} @ ${event.date ?? '?'}`;

  if (!event.sourceId || typeof event.sourceId !== 'string') {
    fail('event.no_source', 'every event needs a sourceId (or a `system:*` id)', event);
  }
  if (!KIND_SET.has(event.kind)) {
    fail('event.bad_kind', `unknown kind "${event.kind}" (${at()})`, event);
  }
  if (!PHASE_SET.has(event.phase)) {
    fail('event.bad_phase', `unknown phase "${event.phase}" (${at()})`, event);
  }
  if (!REALIZATION_SET.has(event.realization)) {
    fail('event.bad_realization', `unknown realization "${event.realization}" (${at()})`, event);
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    fail('event.bad_seq', `seq must be a non-negative integer, got ${event.seq} (${at()})`, event);
  }

  // 1. Money is integer cents. No float ever reaches the ledger.
  if (!isCents(event.cashAmount)) {
    fail('event.cash_not_cents',
      `cashAmount must be integer cents, got ${event.cashAmount} (${at()})`, event);
  }
  if (!isCents(event.taxableAmount)) {
    fail('event.taxable_not_cents',
      `taxableAmount must be integer cents, got ${event.taxableAmount} (${at()})`, event);
  }

  // 7/8. Dates.
  if (!isValidISO(event.date)) {
    fail('event.bad_date', `date must be a real 'YYYY-MM-DD', got "${event.date}"`, event);
  }
  if (event.period !== toPeriod(event.date)) {
    fail('event.period_mismatch',
      `period "${event.period}" does not match date "${event.date}"`, event);
  }

  // 2. The tax triple is all-or-nothing.
  const taxed = event.taxableAmount !== 0;
  if (taxed !== (event.taxCategory !== null)) {
    fail('event.tax_category_mismatch',
      `taxableAmount ${event.taxableAmount} and taxCategory ${JSON.stringify(event.taxCategory)} ` +
      `must be set together (${at()})`, event);
  }
  if (taxed !== (event.taxYear !== null)) {
    fail('event.tax_year_mismatch',
      `taxableAmount ${event.taxableAmount} and taxYear ${JSON.stringify(event.taxYear)} ` +
      `must be set together (${at()})`, event);
  }
  if (taxed && !TAX_CATEGORY_SET.has(event.taxCategory)) {
    fail('event.bad_tax_category', `unknown taxCategory "${event.taxCategory}" (${at()})`, event);
  }
  if (taxed && !Number.isInteger(event.taxYear)) {
    fail('event.bad_tax_year', `taxYear must be an integer, got ${event.taxYear} (${at()})`, event);
  }

  // 3. Non-cash events move no cash. That is the whole point of the kind.
  if (event.kind === 'noncash' && event.cashAmount !== 0) {
    fail('event.noncash_moved_cash',
      `a 'noncash' event must have cashAmount 0, got ${event.cashAmount} — ` +
      'depreciation reduces taxable income without reducing cash', event);
  }

  // 4. Withholding reduces cash and never touches taxable income.
  if (event.kind === 'withholding') {
    if (event.cashAmount >= 0) {
      fail('event.withholding_not_negative',
        `withholding must reduce cash, got ${event.cashAmount} (${at()})`, event);
    }
    if (event.taxableAmount !== 0) {
      fail('event.withholding_taxable',
        'withholding must not move taxable income — it is a payment, not a deduction', event);
    }
    if (!event.personId) {
      fail('event.withholding_no_person',
        'withholding needs a personId: the Social Security wage base is per person', event);
    }
  }

  // 5. Transfers are net-worth neutral and never taxable.
  if (event.kind === 'transfer') {
    if (event.taxableAmount !== 0) {
      fail('event.transfer_taxable',
        'a transfer between your own accounts is not income — taxableAmount must be 0', event);
    }
    if (!event.groupId) {
      fail('event.transfer_no_group',
        'a transfer needs a groupId so its legs can be checked to sum to zero', event);
    }
  }

  // 6. Contributions: pre-tax moves taxable with cash, Roth does not.
  if (event.kind === 'contribution') {
    if (!event.groupId) {
      fail('event.contribution_no_group',
        'a contribution needs a groupId tying the cash leg to the receiving account', event);
    }
    if (event.taxableAmount !== 0 && event.taxableAmount !== event.cashAmount) {
      fail('event.contribution_taxable_mismatch',
        `a pre-tax contribution reduces cash and taxable income by the same amount; ` +
        `got cash ${event.cashAmount} vs taxable ${event.taxableAmount} (${at()})`, event);
    }
  }

  // 9. Probability.
  if (typeof event.probability !== 'number' || !(event.probability >= 0 && event.probability <= 1)) {
    fail('event.bad_probability',
      `probability must be within 0..1, got ${event.probability} (${at()})`, event);
  }

  // 11. essential/cutPriority belong to expenses alone.
  if (event.kind !== 'expense') {
    if (event.essential !== null) {
      fail('event.essential_on_non_expense',
        `essential is only meaningful on expenses, got ${event.essential} on '${event.kind}'`, event);
    }
    if (event.cutPriority !== null) {
      fail('event.cut_priority_on_non_expense',
        `cutPriority is only meaningful on expenses, got ${event.cutPriority} on '${event.kind}'`, event);
    }
  } else {
    if (event.essential !== null && typeof event.essential !== 'boolean') {
      fail('event.bad_essential', `essential must be a boolean or null, got ${event.essential}`, event);
    }
    if (event.cutPriority !== null && ![1, 2, 3, 4, 5].includes(event.cutPriority)) {
      fail('event.bad_cut_priority', `cutPriority must be 1-5 or null, got ${event.cutPriority}`, event);
    }
  }

  if (!event.account || typeof event.account !== 'string') {
    fail('event.no_account', `every event needs an account (${at()})`, event);
  }
  if (typeof event.category !== 'string' || event.category === '') {
    fail('event.no_category', `every event needs a category (${at()})`, event);
  }

  // 12. Tags sorted and deduped, so the canonical hash is stable.
  if (!Array.isArray(event.tags)) {
    fail('event.bad_tags', `tags must be an array (${at()})`, event);
  }
  for (let i = 1; i < event.tags.length; i++) {
    if (event.tags[i] <= event.tags[i - 1]) {
      fail('event.tags_unsorted',
        `tags must be sorted and deduped for hash stability, got ${JSON.stringify(event.tags)}`, event);
    }
  }

  if (event.id !== eventId(event)) {
    fail('event.bad_id', `id "${event.id}" does not match its parts (expected "${eventId(event)}")`, event);
  }

  return event;
}

/**
 * Build a validated, frozen event from a partial. Defaults fill in everything the caller
 * did not state, so a compiler only writes the fields it actually means.
 */
export function makeEvent(partial) {
  if (!partial || typeof partial !== 'object') {
    fail('event.not_object', `makeEvent needs an object, got ${typeof partial}`, partial);
  }

  const unknown = Object.keys(partial).filter((k) => !EVENT_FIELDS.includes(k));
  if (unknown.length > 0) {
    fail('event.unknown_field',
      `unknown event field(s): ${unknown.join(', ')}. The event shape is frozen on purpose — ` +
      'see the "why the event field list is frozen" note in model/types.js. ' +
      'Emit a separate event, or add a derived helper to events.js.', partial);
  }

  // An ABSENT key takes the default; an EXPLICIT null means null and is then validated.
  // `??` would conflate the two, so `taxYear: null` on a taxable event would be silently
  // "corrected" to the derived year instead of failing.
  const given = (key, fallback) => (key in partial ? partial[key] : fallback);

  const date = partial.date;
  const taxableAmount = given('taxableAmount', 0);
  const derivedTaxYear = taxableAmount !== 0 && isValidISO(date) ? yearOf(date) : null;

  const event = {
    sourceId: partial.sourceId,
    groupId: given('groupId', null),
    personId: given('personId', null),
    date,
    period: given('period', isValidISO(date) ? toPeriod(date) : undefined),
    kind: partial.kind,
    phase: partial.phase,
    seq: given('seq', 0),
    account: partial.account,
    cashAmount: given('cashAmount', 0),
    taxableAmount,
    taxCategory: given('taxCategory', null),
    taxYear: given('taxYear', derivedTaxYear),
    probability: given('probability', 1),
    realization: given('realization', 'certain'),
    category: partial.category,
    essential: given('essential', null),
    cutPriority: given('cutPriority', null),
    tags: normaliseTags(given('tags', [])),
    label: given('label', ''),
    meta: given('meta', {}),
    id: '',
  };
  event.id = partial.id ?? eventId(event);

  validateEvent(event);
  Object.freeze(event.tags);
  return Object.freeze(event);
}

/** Sort and dedupe tags so two compilers emitting the same tags hash identically. */
export function normaliseTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) fail('event.bad_tags', `tags must be an array, got ${typeof tags}`);
  return [...new Set(tags)].sort();
}

/** Derive a new event with some fields changed. Used by `realize()`; never mutates. */
export function withEvent(event, changes) {
  const next = { ...event, ...changes };
  if (changes.tags) next.tags = normaliseTags(changes.tags);
  if (!('id' in changes)) next.id = eventId(next);
  validateEvent(next);
  Object.freeze(next.tags);
  return Object.freeze(next);
}

/* -------------------------------------------------------------------------- */
/* Cross-event invariants                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A transfer or contribution group must sum to zero in cash: money moving between your own
 * accounts changes where it is, not how much of it there is. This is what makes
 * invariant #2 (transfers are net-worth neutral) true by construction.
 */
export function validateGroup(events) {
  if (events.length === 0) return events;

  const movesOwnMoney = events.every((e) => e.kind === 'transfer' || e.kind === 'contribution');
  if (!movesOwnMoney) return events;

  const net = sumCents(events.map((e) => e.cashAmount));
  if (net !== 0) {
    fail('event.group_unbalanced',
      `group "${events[0].groupId}" moves money between your own accounts but its legs sum ` +
      `to ${net} cents instead of 0 — one leg is missing or has the wrong sign`, events[0]);
  }
  return events;
}

/** Ids must be unique, or two events silently collapse into one in every rollup. */
export function assertUniqueIds(events) {
  const seen = new Map();
  for (const event of events) {
    if (seen.has(event.id)) {
      fail('event.duplicate_id',
        `two events share the id "${event.id}". A compiler emitted twice in the same ` +
        '(date, phase) without bumping `seq`.', event);
    }
    seen.set(event.id, event);
  }
  return events;
}

/** True when the event settles inside the projection horizon. */
export function isWithinHorizon(event, horizon) {
  return isWithin(event.date, horizon.startDate, horizon.endDate);
}

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A TOTAL order: (date, phase, sourceId, seq, id).
 *
 * Totality matters more than the specific keys. A partial order lets equal elements
 * permute between runs, which makes golden files flap and determinism tests fail
 * intermittently — the worst kind of failure to debug.
 */
export function compareEvents(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const pa = PHASE_ORDER[a.phase];
  const pb = PHASE_ORDER[b.phase];
  if (pa !== pb) return pa - pb;
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Returns a new sorted array; does not mutate the input. */
export function sortEvents(events) {
  return [...events].sort(compareEvents);
}

/* -------------------------------------------------------------------------- */
/* Rollups and derived views                                                   */
/* -------------------------------------------------------------------------- */

/** Σ cashAmount over events matching `predicate`. */
export function sumCash(events, predicate = () => true) {
  return sumCents(events.filter(predicate).map((e) => e.cashAmount));
}

/** Σ taxableAmount over events matching `predicate`. */
export function sumTaxable(events, predicate = () => true) {
  return sumCents(events.filter(predicate).map((e) => e.taxableAmount));
}

/** Group events into a Map keyed by whatever `keyOf` returns. */
export function groupBy(events, keyOf) {
  const out = new Map();
  for (const event of events) {
    const key = keyOf(event);
    const bucket = out.get(key);
    if (bucket) bucket.push(event);
    else out.set(key, [event]);
  }
  return out;
}

/** Σ cashAmount per key. The shape attribution and the ledger rollups both want. */
export function totalsBy(events, keyOf) {
  const out = Object.create(null);
  for (const event of events) {
    const key = keyOf(event);
    out[key] = (out[key] ?? 0) + event.cashAmount;
  }
  return out;
}

export const byPeriod = (events) => groupBy(events, (e) => e.period);
export const bySource = (events) => groupBy(events, (e) => e.sourceId);

/**
 * Accumulate taxable income into {year: {personId: {category: cents}}}.
 *
 * This is pass A's input. It never reads a balance, which is what keeps the two-pass
 * architecture non-circular.
 */
export function accumulateTaxable(events) {
  const book = Object.create(null);
  for (const event of events) {
    if (event.taxableAmount === 0) continue;
    const person = event.personId ?? 'household';
    const year = (book[event.taxYear] ??= Object.create(null));
    const bucket = (year[person] ??= Object.create(null));
    bucket[event.taxCategory] = (bucket[event.taxCategory] ?? 0) + event.taxableAmount;
  }
  return book;
}

/* ---- derived paycheck views ----
 *
 * These exist so that `netPay`, `withholding` and friends never become event FIELDS.
 * See the frozen-field-list note in types.js.
 */

export const eventsInGroup = (events, groupId) => events.filter((e) => e.groupId === groupId);

/**
 * Take-home pay: what actually landed in the account the wages were paid into.
 *
 * Deliberately not "the sum of every leg". A pre-tax deferral has two legs — money out of
 * the pay account and into the retirement account — which cancel when summed across
 * accounts. Take-home is the movement in the PAY account alone, so a 10% 401(k)
 * contribution correctly reduces it.
 */
export function netPayFor(events, groupId) {
  const legs = events.filter((e) => e.groupId === groupId);
  const wages = legs.find((e) => e.kind === 'income');
  if (!wages) return sumCents(legs.map((e) => e.cashAmount));
  return sumCents(legs.filter((e) => e.account === wages.account).map((e) => e.cashAmount));
}

/** Gross before deductions and withholding. */
export function grossFor(events, groupId) {
  return sumCash(events, (e) => e.groupId === groupId && e.kind === 'income');
}

export function withheldFor(events, groupId) {
  return -sumCash(events, (e) => e.groupId === groupId && e.kind === 'withholding');
}

export function contributedFor(events, groupId) {
  return -sumCash(events, (e) => e.groupId === groupId && e.kind === 'contribution' && e.cashAmount < 0);
}

/** Every distinct account the stream touches, sorted for stable output. */
export function accountsIn(events) {
  return [...new Set(events.map((e) => e.account))].sort();
}

export { assertCents };
