/** Fixture builders and assertion helpers shared across tests. */

import assert from 'node:assert/strict';
import { makeEvent } from '../../model/events.js';

/** Run `fn` and return the error `code` it threw, or null if it did not throw. */
export function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code ?? `<no code: ${err.message}>`;
  }
  return null;
}

/** Assert that `fn` throws with exactly `expected` as its error code. */
export function throwsCode(fn, expected, message) {
  const actual = codeOf(fn);
  assert.equal(actual, expected, message ?? `expected error code "${expected}", got "${actual}"`);
}

/** A minimal valid event; override any field. */
export function anEvent(overrides = {}) {
  return makeEvent({
    sourceId: 'src_test',
    date: '2026-08-31',
    kind: 'income',
    phase: 'INCOME_GROSS',
    account: 'cash',
    category: 'salary',
    cashAmount: 100_000,
    taxableAmount: 100_000,
    taxCategory: 'w2_wages',
    personId: 'p1',
    label: 'Test income',
    ...overrides,
  });
}

/** A raw partial (not built) so tests can feed makeEvent something invalid. */
export function eventPartial(overrides = {}) {
  return {
    sourceId: 'src_test',
    date: '2026-08-31',
    kind: 'income',
    phase: 'INCOME_GROSS',
    account: 'cash',
    category: 'salary',
    cashAmount: 100_000,
    taxableAmount: 100_000,
    taxCategory: 'w2_wages',
    personId: 'p1',
    ...overrides,
  };
}

/** A two-leg transfer that balances. */
export function aTransfer({ from = 'cash', to = 'savings', amount = 20_000, date = '2026-08-31', groupId = 'grp_t1' } = {}) {
  return [
    makeEvent({
      sourceId: 'src_transfer', groupId, date, kind: 'transfer', phase: 'TRANSFER',
      account: from, category: 'transfer', cashAmount: -amount, seq: 0,
    }),
    makeEvent({
      sourceId: 'src_transfer', groupId, date, kind: 'transfer', phase: 'TRANSFER',
      account: to, category: 'transfer', cashAmount: amount, seq: 1,
    }),
  ];
}

/** Deterministic pseudo-random generator, so shuffles are reproducible across runs. */
export function seededRandom(seed = 12345) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function shuffle(list, random = seededRandom()) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
