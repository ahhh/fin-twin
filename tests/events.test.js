import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_FIELDS, EVENT_KINDS, PHASES, PHASE_ORDER, TAX_CATEGORIES,
  accountsIn, accumulateTaxable, assertUniqueIds, compareEvents, contributedFor, eventId,
  grossFor, groupBy, makeEvent, netPayFor, normaliseTags, sortEvents, sumCash, sumTaxable,
  totalsBy, validateGroup, withEvent, withheldFor,
} from '../model/events.js';
import { anEvent, aTransfer, eventPartial, seededRandom, shuffle, throwsCode } from './helpers/build.js';

/* ---- construction ---- */

test('makeEvent fills defaults so a compiler writes only what it means', () => {
  const e = anEvent();
  assert.equal(e.probability, 1);
  assert.equal(e.realization, 'certain');
  assert.equal(e.groupId, null);
  assert.equal(e.seq, 0);
  assert.deepEqual(e.tags, []);
  assert.deepEqual(e.meta, {});
  assert.equal(e.period, '2026-08', 'period is derived from date');
  assert.equal(e.taxYear, 2026, 'taxYear is derived from date when taxable');
  assert.equal(e.id, 'src_test:2026-08-31:INCOME_GROSS:0');
});

test('events are frozen, including their tags', () => {
  const e = anEvent({ tags: ['b', 'a'] });
  assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(e.tags));
  assert.throws(() => { e.cashAmount = 1; }, TypeError);
});

test('the event field list is frozen — an unknown field is a build failure, not a silent extra', () => {
  // This is the guard described in types.js: `withholding` as a FIELD would be invisible
  // to attribution, so it must be a separate event instead.
  throwsCode(() => makeEvent(eventPartial({ withholding: 150_000 })), 'event.unknown_field');
  throwsCode(() => makeEvent(eventPartial({ netPay: 150_000 })), 'event.unknown_field');
  assert.equal(EVENT_FIELDS.length, new Set(EVENT_FIELDS).size, 'field list has duplicates');
  assert.deepEqual([...EVENT_FIELDS].sort(), [...EVENT_FIELDS], 'field list must stay sorted');
});

test('every built event has exactly the frozen key set', () => {
  for (const e of [anEvent(), anEvent({ kind: 'expense', taxableAmount: 0, taxCategory: null, essential: true, category: 'housing', personId: null }), ...aTransfer()]) {
    assert.deepEqual(Object.keys(e).sort(), [...EVENT_FIELDS], `unexpected shape for ${e.id}`);
  }
});

/* ---- invariants, each asserting its own code ---- */

test('invariant: money must be integer cents — no float reaches the ledger', () => {
  throwsCode(() => makeEvent(eventPartial({ cashAmount: 100.5 })), 'event.cash_not_cents');
  throwsCode(() => makeEvent(eventPartial({ taxableAmount: 0.1 + 0.2 })), 'event.taxable_not_cents');
  throwsCode(() => makeEvent(eventPartial({ cashAmount: '100' })), 'event.cash_not_cents');
});

test('invariant: taxableAmount, taxCategory and taxYear are all-or-nothing', () => {
  throwsCode(() => makeEvent(eventPartial({ taxableAmount: 100, taxCategory: null })), 'event.tax_category_mismatch');
  throwsCode(() => makeEvent(eventPartial({ taxableAmount: 0, taxCategory: 'w2_wages' })), 'event.tax_category_mismatch');
  throwsCode(() => makeEvent(eventPartial({ taxableAmount: 100, taxYear: null })), 'event.tax_year_mismatch');
  throwsCode(() => makeEvent(eventPartial({ taxCategory: 'wages' })), 'event.bad_tax_category');
});

test('invariant: a noncash event moves no cash — depreciation does not reduce cash', () => {
  throwsCode(
    () => makeEvent(eventPartial({ kind: 'noncash', phase: 'EXPENSE', cashAmount: -100, taxableAmount: -100, taxCategory: 'rental_net', personId: null })),
    'event.noncash_moved_cash',
  );
  const ok = makeEvent(eventPartial({
    kind: 'noncash', phase: 'EXPENSE', cashAmount: 0,
    taxableAmount: -500_00, taxCategory: 'rental_net', category: 'depreciation', personId: null,
  }));
  assert.equal(ok.cashAmount, 0);
  assert.equal(ok.taxableAmount, -500_00);
});

test('invariant: withholding reduces cash, never taxable income, and names a person', () => {
  const base = { kind: 'withholding', phase: 'WITHHOLDING', category: 'tax', taxableAmount: 0, taxCategory: null };
  throwsCode(() => makeEvent(eventPartial({ ...base, cashAmount: 150_00 })), 'event.withholding_not_negative');
  throwsCode(
    () => makeEvent(eventPartial({ ...base, cashAmount: -150_00, taxableAmount: -150_00, taxCategory: 'w2_wages' })),
    'event.withholding_taxable',
  );
  throwsCode(() => makeEvent(eventPartial({ ...base, cashAmount: -150_00, personId: null })), 'event.withholding_no_person');
});

test('invariant: a transfer is not income and needs a group', () => {
  const base = { kind: 'transfer', phase: 'TRANSFER', category: 'transfer', cashAmount: -100_00, groupId: 'g1' };
  throwsCode(
    () => makeEvent(eventPartial({ ...base, taxableAmount: 100_00, taxCategory: 'w2_wages' })),
    'event.transfer_taxable',
  );
  throwsCode(
    () => makeEvent(eventPartial({ ...base, groupId: null, taxableAmount: 0, taxCategory: null })),
    'event.transfer_no_group',
  );
});

test('invariant: a pre-tax contribution moves cash and taxable equally; Roth moves only cash', () => {
  const preTax = makeEvent(eventPartial({
    kind: 'contribution', phase: 'PRETAX_DEDUCTION', category: 'retirement', groupId: 'g1',
    cashAmount: -68_000, taxableAmount: -68_000, taxCategory: 'pretax_deferral',
  }));
  assert.equal(preTax.cashAmount, preTax.taxableAmount);

  const roth = makeEvent(eventPartial({
    kind: 'contribution', phase: 'POSTTAX_CONTRIBUTION', category: 'retirement', groupId: 'g1',
    cashAmount: -68_000, taxableAmount: 0, taxCategory: null,
  }));
  assert.equal(roth.taxableAmount, 0);

  throwsCode(
    () => makeEvent(eventPartial({
      kind: 'contribution', phase: 'PRETAX_DEDUCTION', category: 'retirement', groupId: 'g1',
      cashAmount: -68_000, taxableAmount: -30_000, taxCategory: 'pretax_deferral',
    })),
    'event.contribution_taxable_mismatch',
  );
  throwsCode(
    () => makeEvent(eventPartial({
      kind: 'contribution', phase: 'PRETAX_DEDUCTION', category: 'retirement',
      cashAmount: -68_000, taxableAmount: 0, taxCategory: null,
    })),
    'event.contribution_no_group',
  );
});

test('invariant: dates are real and the period matches', () => {
  throwsCode(() => makeEvent(eventPartial({ date: '2026-02-30' })), 'event.bad_date');
  throwsCode(() => makeEvent(eventPartial({ date: 'August 31 2026' })), 'event.bad_date');
  throwsCode(() => makeEvent(eventPartial({ period: '2026-09' })), 'event.period_mismatch');
});

test('invariant: probability stays within 0..1', () => {
  throwsCode(() => makeEvent(eventPartial({ probability: 1.5 })), 'event.bad_probability');
  throwsCode(() => makeEvent(eventPartial({ probability: -0.1 })), 'event.bad_probability');
  throwsCode(() => makeEvent(eventPartial({ probability: null })), 'event.bad_probability');
  assert.equal(makeEvent(eventPartial({ probability: 0 })).probability, 0);
});

test('invariant: essential and cutPriority belong to expenses alone', () => {
  throwsCode(() => makeEvent(eventPartial({ essential: true })), 'event.essential_on_non_expense');
  throwsCode(() => makeEvent(eventPartial({ cutPriority: 2 })), 'event.cut_priority_on_non_expense');

  const expense = {
    kind: 'expense', phase: 'EXPENSE', category: 'housing', cashAmount: -260_000,
    taxableAmount: 0, taxCategory: null, personId: null,
  };
  throwsCode(() => makeEvent(eventPartial({ ...expense, cutPriority: 9 })), 'event.bad_cut_priority');
  throwsCode(() => makeEvent(eventPartial({ ...expense, essential: 'yes' })), 'event.bad_essential');
  assert.equal(makeEvent(eventPartial({ ...expense, essential: true, cutPriority: 1 })).essential, true);
});

test('invariant: account, category, kind, phase and seq are all required and checked', () => {
  throwsCode(() => makeEvent(eventPartial({ account: '' })), 'event.no_account');
  throwsCode(() => makeEvent(eventPartial({ category: '' })), 'event.no_category');
  throwsCode(() => makeEvent(eventPartial({ sourceId: '' })), 'event.no_source');
  throwsCode(() => makeEvent(eventPartial({ kind: 'revenue' })), 'event.bad_kind');
  throwsCode(() => makeEvent(eventPartial({ phase: 'LATER' })), 'event.bad_phase');
  throwsCode(() => makeEvent(eventPartial({ seq: -1 })), 'event.bad_seq');
  throwsCode(() => makeEvent(eventPartial({ realization: 'maybe' })), 'event.bad_realization');
  throwsCode(() => makeEvent(null), 'event.not_object');
});

test('invariant: tags are sorted and deduped so hashes stay stable', () => {
  assert.deepEqual(anEvent({ tags: ['zebra', 'apple', 'apple'] }).tags, ['apple', 'zebra']);
  assert.deepEqual(normaliseTags(undefined), []);
  throwsCode(() => makeEvent(eventPartial({ tags: 'a,b' })), 'event.bad_tags');
});

test('invariant: the id must match its parts', () => {
  throwsCode(() => makeEvent(eventPartial({ id: 'made-up' })), 'event.bad_id');
  assert.equal(
    eventId({ sourceId: 's', date: '2026-01-01', phase: 'EXPENSE', seq: 3 }),
    's:2026-01-01:EXPENSE:3',
  );
});

test('invariant: ids are unique across a stream', () => {
  const a = anEvent();
  const b = anEvent(); // identical parts -> identical id
  throwsCode(() => assertUniqueIds([a, b]), 'event.duplicate_id');
  assert.doesNotThrow(() => assertUniqueIds([a, anEvent({ seq: 1 })]));
});

test('invariant: a transfer group must sum to zero in cash', () => {
  assert.doesNotThrow(() => validateGroup(aTransfer()));

  const [out] = aTransfer();
  const wrongWay = makeEvent({
    sourceId: 'src_transfer', groupId: 'grp_t1', date: '2026-08-31', kind: 'transfer',
    phase: 'TRANSFER', account: 'savings', category: 'transfer', cashAmount: -20_000, seq: 1,
  });
  throwsCode(() => validateGroup([out, wrongWay]), 'event.group_unbalanced');
});

/* ---- ordering ---- */

test('sortEvents is a total order: shuffling 1000 events always yields the same sequence', () => {
  const events = [];
  const dates = ['2026-08-30', '2026-08-31', '2026-09-01'];
  for (let i = 0; i < 1000; i++) {
    events.push(anEvent({
      sourceId: `src_${i % 7}`,
      date: dates[i % dates.length],
      phase: PHASES[1 + (i % 5)],
      seq: i % 3,
      cashAmount: 1_00 + i,
      taxableAmount: 0,
      taxCategory: null,
      // keep ids distinct even when the sort keys collide
      label: `e${i}`,
      tags: [`n${i}`],
    }));
  }
  const unique = new Map(events.map((e) => [e.id, e]));
  const distinct = [...unique.values()];

  const reference = sortEvents(distinct).map((e) => e.id);
  const random = seededRandom(99);
  for (let trial = 0; trial < 25; trial++) {
    assert.deepEqual(sortEvents(shuffle(distinct, random)).map((e) => e.id), reference,
      `sort order changed on trial ${trial} — the comparator is not total`);
  }
});

test('sort keys are applied in the documented priority', () => {
  const day = '2026-08-31';
  const income = anEvent({ date: day, phase: 'INCOME_GROSS' });
  const expense = anEvent({ date: day, phase: 'EXPENSE', kind: 'expense', taxableAmount: 0, taxCategory: null, category: 'housing', personId: null, cashAmount: -1 });
  const earlier = anEvent({ date: '2026-08-30', phase: 'EXPENSE', kind: 'expense', taxableAmount: 0, taxCategory: null, category: 'housing', personId: null, cashAmount: -1 });

  assert.ok(compareEvents(earlier, income) < 0, 'date beats phase');
  assert.ok(compareEvents(income, expense) < 0, 'INCOME_GROSS sorts before EXPENSE');
  assert.ok(compareEvents(anEvent({ seq: 0 }), anEvent({ seq: 1 })) < 0, 'seq breaks ties');
  assert.equal(compareEvents(income, income), 0);
  assert.ok(sortEvents([]).length === 0);
});

test('pre-tax deductions sort above withholding, because withholding is computed net of them', () => {
  assert.ok(
    PHASE_ORDER.PRETAX_DEDUCTION < PHASE_ORDER.WITHHOLDING,
    'a 401(k) deferral must land before withholding is taken',
  );
  assert.ok(PHASE_ORDER.INCOME_GROSS < PHASE_ORDER.PRETAX_DEDUCTION);
  assert.ok(PHASE_ORDER.EXPENSE < PHASE_ORDER.POSTTAX_CONTRIBUTION, 'bills before discretionary investing');
  assert.ok(PHASE_ORDER.ESTIMATED_TAX < PHASE_ORDER.CLOSE);
});

test('sortEvents does not mutate its input', () => {
  const input = [anEvent({ seq: 2 }), anEvent({ seq: 1 })];
  const before = input.map((e) => e.id);
  sortEvents(input);
  assert.deepEqual(input.map((e) => e.id), before);
});

/* ---- rollups ---- */

test('sumCash and sumTaxable filter independently', () => {
  const events = [
    anEvent({ cashAmount: 850_000, taxableAmount: 1_000_000, seq: 0 }),
    anEvent({ kind: 'withholding', phase: 'WITHHOLDING', category: 'tax', cashAmount: -150_000, taxableAmount: 0, taxCategory: null, seq: 1 }),
  ];
  assert.equal(sumCash(events), 700_000);
  assert.equal(sumTaxable(events), 1_000_000, 'withholding does not reduce taxable income');
  assert.equal(sumCash(events, (e) => e.kind === 'income'), 850_000);
});

test('totalsBy and groupBy bucket by any key', () => {
  const events = [
    anEvent({ sourceId: 'a', cashAmount: 100, taxableAmount: 0, taxCategory: null, seq: 0 }),
    anEvent({ sourceId: 'a', cashAmount: 50, taxableAmount: 0, taxCategory: null, seq: 1 }),
    anEvent({ sourceId: 'b', cashAmount: 25, taxableAmount: 0, taxCategory: null, seq: 2 }),
  ];
  assert.deepEqual({ ...totalsBy(events, (e) => e.sourceId) }, { a: 150, b: 25 });
  assert.equal(groupBy(events, (e) => e.sourceId).get('a').length, 2);
  assert.deepEqual(accountsIn(events), ['cash']);
});

test('accumulateTaxable books by year, person and category', () => {
  const book = accumulateTaxable([
    anEvent({ personId: 'p1', taxableAmount: 100_000_00, taxCategory: 'w2_wages', seq: 0 }),
    anEvent({ personId: 'p1', taxableAmount: -24_500_00, taxCategory: 'pretax_deferral', cashAmount: -24_500_00, kind: 'contribution', phase: 'PRETAX_DEDUCTION', groupId: 'g', category: 'retirement', seq: 1 }),
    anEvent({ personId: 'p2', taxableAmount: 50_000_00, taxCategory: 'se_net_profit', seq: 2 }),
    anEvent({ personId: 'p1', date: '2027-01-15', taxableAmount: 5_000_00, taxCategory: 'w2_wages', seq: 3 }),
  ]);

  assert.equal(book[2026].p1.w2_wages, 100_000_00);
  assert.equal(book[2026].p1.pretax_deferral, -24_500_00, 'deferrals book negative');
  assert.equal(book[2026].p2.se_net_profit, 50_000_00);
  assert.equal(book[2027].p1.w2_wages, 5_000_00);
  assert.equal(book[2026].p2.w2_wages, undefined, 'no cross-contamination between people');
});

test('paycheck views are derived, not stored', () => {
  const g = 'pay_2026_08';
  const legs = [
    anEvent({ groupId: g, cashAmount: 1_000_000, taxableAmount: 1_000_000, seq: 0 }),
    anEvent({ groupId: g, kind: 'contribution', phase: 'PRETAX_DEDUCTION', category: 'retirement', cashAmount: -80_000, taxableAmount: -80_000, taxCategory: 'pretax_deferral', seq: 1 }),
    anEvent({ groupId: g, kind: 'withholding', phase: 'WITHHOLDING', category: 'tax', cashAmount: -150_000, taxableAmount: 0, taxCategory: null, seq: 2 }),
    anEvent({ groupId: g, kind: 'withholding', phase: 'WITHHOLDING', category: 'tax', cashAmount: -70_000, taxableAmount: 0, taxCategory: null, seq: 3 }),
  ];
  assert.equal(grossFor(legs, g), 1_000_000);
  assert.equal(withheldFor(legs, g), 220_000);
  assert.equal(contributedFor(legs, g), 80_000);
  assert.equal(netPayFor(legs, g), 700_000, 'net pay is the sum of the legs, not a stored field');
  assert.equal(sumTaxable(legs), 920_000, 'the deferral reduced taxable income');
});

/* ---- withEvent ---- */

test('withEvent derives a new frozen event and re-validates', () => {
  const original = anEvent();
  const scaled = withEvent(original, { cashAmount: 50_000, taxableAmount: 50_000, realization: 'expected', probability: 0.5 });
  assert.equal(original.cashAmount, 100_000, 'the original is untouched');
  assert.equal(scaled.cashAmount, 50_000);
  assert.ok(Object.isFrozen(scaled));
  throwsCode(() => withEvent(original, { cashAmount: 1.5 }), 'event.cash_not_cents');
});

test('the enums are frozen and internally consistent', () => {
  assert.ok(Object.isFrozen(EVENT_KINDS) && Object.isFrozen(PHASES) && Object.isFrozen(TAX_CATEGORIES));
  assert.equal(Object.keys(PHASE_ORDER).length, PHASES.length);
  assert.equal(PHASE_ORDER[PHASES[0]], 0);
  assert.equal(PHASE_ORDER.CLOSE, PHASES.length - 1, 'CLOSE must sort last');
});
