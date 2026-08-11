/**
 * The month-close walk.
 *
 * Walks the sorted event stream month by month, maintaining a balance per account. The
 * whole close is `balance += cashAmount`, with no special cases — which is only possible
 * because amounts are signed and every flow, including the ones the engine invents, is an
 * event.
 *
 * The balance identity is asserted every month rather than tested once:
 *
 *     closing[account] === opening[account] + Σ cashAmount(events in month, account)
 *
 * If that ever fails, something is computing money outside the event stream, and every
 * downstream number — attribution especially — is untrustworthy.
 *
 * Close rules are the escape hatch for logic that genuinely needs a running balance —
 * covering a sinking-fund shortfall, earmarking a tax reserve, compounding a balance. They
 * may emit events, including events carrying taxable income (savings interest is the
 * obvious case). Those are collected into `taxableFromCloseRules` rather than accepted
 * silently, because they make the projection a fixed point: pass A computed tax before
 * that money existed. `engine.js` iterates until the liability settles.
 */

import { makeEvent, sortEvents, PHASE_ORDER } from './events.js';
import { makeWarning } from './warnings.js';
import { sumCents } from './money.js';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

/** Accounts whose balance counts as spendable liquidity. */
export const DEFAULT_LIQUID_ACCOUNTS = Object.freeze(['cash', 'savings']);

const CLOSE_RULES = new Map();

/**
 * Register a close rule.
 *
 * @param {Object} rule
 * @param {string} rule.id
 * @param {number} rule.order      lower runs first
 * @param {(state, ctx) => void} rule.run
 */
export function registerCloseRule(rule) {
  if (!rule.id || typeof rule.run !== 'function') {
    throw new LedgerError('ledger.bad_close_rule', 'a close rule needs an id and a run function');
  }
  if (CLOSE_RULES.has(rule.id)) {
    throw new LedgerError('ledger.duplicate_close_rule', `close rule "${rule.id}" is already registered`);
  }
  CLOSE_RULES.set(rule.id, Object.freeze({ order: 100, ...rule }));
  return rule;
}

export const listCloseRules = () => [...CLOSE_RULES.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
export const resetCloseRulesForTests = () => CLOSE_RULES.clear();

/**
 * @param {Array} events    sorted, realised events
 * @param {Object} options
 * @param {Object} options.openingBalances  {accountId: cents}
 * @param {Object} options.horizon
 * @param {string[]} [options.liquidAccounts]
 * @param {Object} [options.context]        extra data close rules may read (e.g. yearResults)
 */
export function close(events, { openingBalances = {}, horizon, liquidAccounts = DEFAULT_LIQUID_ACCOUNTS, context = {} } = {}) {
  const warnings = [];
  const emitted = [];
  const taxableFromCloseRules = [];

  const balances = Object.create(null);
  for (const account of accountsMentioned(events, openingBalances)) {
    balances[account] = openingBalances[account] ?? 0;
  }

  const byPeriod = new Map();
  for (const event of events) {
    const bucket = byPeriod.get(event.period);
    if (bucket) bucket.push(event);
    else byPeriod.set(event.period, [event]);
  }

  const months = [];
  let minLiquid = null;

  for (const period of horizon.months) {
    const opening = { ...balances };
    let monthEvents = byPeriod.get(period) ?? [];

    // Track the running liquid total so the minimum is the true intra-month low, not the
    // month-end figure. A month can dip below zero mid-way and recover by the 31st.
    const applied = [];
    for (const event of monthEvents) {
      balances[event.account] = (balances[event.account] ?? 0) + event.cashAmount;
      applied.push(event);
      const liquid = liquidTotal(balances, liquidAccounts);
      if (minLiquid === null || liquid < minLiquid.amount) {
        minLiquid = { amount: liquid, period, date: event.date, eventId: event.id, label: event.label };
      }
    }

    // Close rules see the month's end state and may add events to it.
    const extra = runCloseRules({
      period, balances, opening, events: applied, horizon, liquidAccounts, context, warnings,
      taxableFromCloseRules,
    });
    for (const event of extra) {
      balances[event.account] = (balances[event.account] ?? 0) + event.cashAmount;
      applied.push(event);
      emitted.push(event);
      const liquid = liquidTotal(balances, liquidAccounts);
      if (minLiquid === null || liquid < minLiquid.amount) {
        minLiquid = { amount: liquid, period, date: event.date, eventId: event.id, label: event.label };
      }
    }

    if (applied.length === 0 && months.length === 0 && minLiquid === null) {
      minLiquid = { amount: liquidTotal(balances, liquidAccounts), period, date: null, eventId: null, label: 'opening balance' };
    }

    const ordered = sortEvents(applied);
    const closing = { ...balances };

    // The identity. Asserted every month, in every run.
    for (const account of Object.keys(closing)) {
      const moved = sumCents(ordered.filter((e) => e.account === account).map((e) => e.cashAmount));
      const expected = (opening[account] ?? 0) + moved;
      if (closing[account] !== expected) {
        throw new LedgerError('ledger.balance_identity',
          `${period}: ${account} closed at ${closing[account]} but opening ${opening[account] ?? 0} ` +
          `plus ${moved} of movement is ${expected}. Something computed money outside the event stream.`);
      }
    }

    months.push({
      period,
      opening,
      closing,
      byKind: totalsBy(ordered, (e) => e.kind),
      byCategory: totalsBy(ordered, (e) => e.category),
      bySource: totalsBy(ordered, (e) => e.sourceId),
      liquid: liquidTotal(closing, liquidAccounts),
      events: ordered.map((e) => e.id),
    });

    if (closing.cash !== undefined && closing.cash < 0) {
      warnings.push(makeWarning('cash.below_zero', { period, amount: formatCents(closing.cash) }));
    }
  }

  return {
    months,
    balances: { ...balances },
    minLiquid,
    emitted: sortEvents(emitted),
    // Events a close rule produced that carry taxable income. Non-empty means the
    // projection needs another pass — see the fixed-point loop in engine.js.
    taxableFromCloseRules: sortEvents(taxableFromCloseRules),
    warnings,
  };
}

function runCloseRules({ period, balances, opening, events, horizon, liquidAccounts, context, warnings, taxableFromCloseRules }) {
  const out = [];
  const state = {
    period,
    balances,
    opening,
    events,
    horizon,
    liquidAccounts,
    liquid: () => liquidTotal(balances, liquidAccounts),
    balanceOf: (account) => balances[account] ?? 0,
  };

  for (const rule of listCloseRules()) {
    const ctx = {
      context,
      warn: (code, data = {}) => warnings.push(makeWarning(code, data)),
      emit: (partial) => {
        const event = makeEvent({
          sourceId: `system:${rule.id}`,
          phase: 'CLOSE',
          ...partial,
        });

        // A close rule that emits taxable income turns the projection into a fixed-point
        // problem: pass A computed tax before this money existed. Savings interest is
        // exactly that case — it is taxable, and its size depends on a running balance.
        //
        // The ledger does not judge; it records. `engine.js` iterates until the liability
        // stops moving, and errors if it never settles. What would be unacceptable is
        // producing a number that is silently one iteration stale, which is why this is
        // reported rather than ignored.
        if (event.taxableAmount !== 0) taxableFromCloseRules.push(event);

        out.push(event);
        return event;
      },
    };
    rule.run(state, ctx);
  }
  return out;
}

function totalsBy(events, keyOf) {
  const out = Object.create(null);
  for (const event of events) {
    const key = keyOf(event);
    out[key] = (out[key] ?? 0) + event.cashAmount;
  }
  return out;
}

function liquidTotal(balances, liquidAccounts) {
  let total = 0;
  for (const account of liquidAccounts) total += balances[account] ?? 0;
  return total;
}

function accountsMentioned(events, openingBalances) {
  const set = new Set(Object.keys(openingBalances));
  for (const event of events) set.add(event.account);
  return [...set].sort();
}

function formatCents(cents) {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export { PHASE_ORDER };
