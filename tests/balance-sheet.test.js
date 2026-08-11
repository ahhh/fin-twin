import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules } from '../model/close-rules.js';
import { resolveSources } from '../model/scenarios.js';
import { accountMap, balanceSheet, makeAccount } from '../model/accounts.js';
import { amortise, levelPayment } from '../model/sources/loan.js';
import { sumCents } from '../model/money.js';
import { sumCash } from '../model/events.js';
import { simpleModel, aSource } from './helpers/models.js';
import { PACKS } from './helpers/packs.js';
import { throwsCode } from './helpers/build.js';

before(() => registerBuiltInCloseRules());

/* ---- accounts ---- */

test('a liability is stored as a negative balance, whichever sign the user types', () => {
  // Users think "I owe $300,000". The sign is applied once, here.
  const positive = makeAccount({ id: 'm', kind: 'mortgage', openingBalance: 300_000_00 });
  const negative = makeAccount({ id: 'm', kind: 'mortgage', openingBalance: -300_000_00 });

  assert.equal(positive.openingBalance, -300_000_00);
  assert.equal(negative.openingBalance, -300_000_00, 'entering it negative must not double-negate');
  assert.equal(positive.family, 'liability');
});

test('account kinds know whether their growth is taxable', () => {
  assert.equal(makeAccount({ id: 's', kind: 'savings' }).growthTaxCategory, 'interest',
    'savings interest is taxable in the year it is earned');
  assert.equal(makeAccount({ id: 'b', kind: 'brokerage' }).growthTaxCategory, null,
    'a paper gain is not taxable until it is sold');
  assert.equal(makeAccount({ id: 'r', kind: 'roth_retirement' }).growthTaxCategory, null);
  assert.equal(makeAccount({ id: 'p', kind: 'property' }).growthTaxCategory, null);
});

test('duplicate and unknown accounts are refused', () => {
  throwsCode(() => accountMap([{ id: 'a', kind: 'checking' }, { id: 'a', kind: 'savings' }]),
    'account.duplicate_id');
  throwsCode(() => makeAccount({ id: 'x', kind: 'crypto_wallet' }), 'account.unknown_kind');
});

test('the balance sheet reports debts positive but nets them correctly', () => {
  const accounts = accountMap([
    { id: 'cash', kind: 'checking', openingBalance: 5_000_00 },
    { id: 'house', kind: 'property', openingBalance: 400_000_00 },
    { id: 'mortgage', kind: 'mortgage', openingBalance: 300_000_00 },
  ]);
  const sheet = balanceSheet({ cash: 5_000_00, house: 400_000_00, mortgage: -300_000_00 }, accounts);

  assert.equal(sheet.totalAssets, 405_000_00);
  assert.equal(sheet.totalDebt, 300_000_00, 'debt is shown as a positive number owed');
  assert.equal(sheet.netWorth, 105_000_00);
  assert.equal(sheet.liquidAssets, 5_000_00, 'a house is not liquid');
});

/* ---- amortisation ---- */

test('the level payment matches the standard formula, rounded up to clear the term', () => {
  // The exact figure is $1,798.6512. Rounded to nearest it leaves $1.44 outstanding and
  // needs a 361st payment of $1.45; rounded up it clears in exactly 360.
  assert.equal(levelPayment(300_000_00, 0.06 / 12, 360), 1_798_66);
  assert.equal(levelPayment(10_000_00, 0, 10), 1_000_00, 'a zero-rate loan is just division');
});

test('a loan amortises to exactly zero, in exactly its term', () => {
  const { schedule, monthsToPayoff, totalInterest } = amortise({
    principal: 300_000_00, monthlyRate: 0.06 / 12, payment: levelPayment(300_000_00, 0.06 / 12, 360),
  });

  assert.equal(monthsToPayoff, 360, 'no phantom 361st month');
  assert.equal(schedule[schedule.length - 1].balance, 0, 'a loan ending at −$0.03 would corrupt net worth');
  assert.ok(schedule[359].payment < schedule[0].payment,
    'the final payment is trimmed to whatever is actually left');
  assert.ok(totalInterest > 340_000_00 && totalInterest < 350_000_00,
    `30 years of interest on $300k at 6% should be about $347k, got ${totalInterest / 100}`);

  // Interest falls and principal rises across the life of the loan.
  assert.ok(schedule[0].interest > schedule[359].interest);
  assert.ok(schedule[0].principal < schedule[359].principal);
  assert.equal(schedule[0].interest, 1_500_00, 'first month: 0.5% of $300,000');
});

test('extra payments shorten the loan and cut the interest', () => {
  const rate = 0.06 / 12;
  const payment = levelPayment(300_000_00, rate, 360);

  const plain = amortise({ principal: 300_000_00, monthlyRate: rate, payment });
  const extra = amortise({ principal: 300_000_00, monthlyRate: rate, payment, extra: 200_00 });

  assert.ok(extra.monthsToPayoff < plain.monthsToPayoff - 40, 'an extra $200 should save years');
  assert.ok(extra.totalInterest < plain.totalInterest);
});

test('a payment that does not cover the interest is reported, not looped forever', () => {
  const result = amortise({ principal: 300_000_00, monthlyRate: 0.06 / 12, payment: 100_00 });
  assert.equal(result.neverAmortises, true);
  assert.equal(result.monthsToPayoff, null);
});

/* ---- loans in a projection ---- */

function mortgageModel(overrides = {}) {
  return simpleModel({
    horizon: { startDate: '2026-01-01', endDate: '2026-12-31' },
    openingBalances: {},
    accounts: [
      { id: 'cash', name: 'Checking', kind: 'checking', openingBalance: 50_000_00 },
      { id: 'house', name: 'Home', kind: 'property', openingBalance: 400_000_00, expectedReturn: 0.03 },
      { id: 'mortgage', name: 'Mortgage', kind: 'mortgage', openingBalance: 300_000_00 },
    ],
    sources: [
      aSource('loan', {
        id: 'mortgage', name: 'Mortgage', startDate: '2026-01-01',
        details: {
          principal: 300_000_00, annualRate: 0.06, termMonths: 360,
          liabilityAccount: 'mortgage', fromAccount: 'cash', deductibleInterest: true,
        },
      }),
    ],
    ...overrides,
  });
}

test('a loan payment costs cash but only the interest costs net worth', () => {
  // Invariant #14, now real rather than a stub.
  const run = runProjection(mortgageModel());

  const january = run.months.find((m) => m.period === '2026-01');
  const cashOut = january.closing.cash - january.opening.cash;
  const debtDown = january.closing.mortgage - january.opening.mortgage;

  assert.equal(cashOut, -1_798_66, 'the whole payment leaves the account');
  assert.equal(debtDown, 298_66, 'but only the principal reduces the debt');

  // Net worth fell by the interest alone. House growth is separate, so compare like for like.
  const interest = -sumCash(
    run.events,
    (e) => e.period === '2026-01' && e.kind === 'debt_service' && e.tags.includes('interest'),
  );
  assert.equal(interest, 1_500_00);
  assert.equal(cashOut + debtDown, -interest, 'cash out plus debt down is exactly the interest');
});

test('principal repayment moves cash and debt by the same amount', () => {
  const run = runProjection(mortgageModel());

  const principalOut = sumCash(
    run.events,
    (e) => e.kind === 'debt_service' && e.tags.includes('principal') && e.account === 'cash',
  );
  const principalIn = sumCash(
    run.events,
    (e) => e.kind === 'debt_service' && e.tags.includes('principal') && e.account === 'mortgage',
  );
  assert.equal(principalOut + principalIn, 0, 'the two principal legs must cancel exactly');
});

test('the debt shrinks month by month and never overshoots zero', () => {
  const run = runProjection(mortgageModel());
  let previous = -300_000_00;

  for (const month of run.months) {
    const balance = month.closing.mortgage;
    assert.ok(balance > previous, `${month.period}: the debt should be smaller than last month`);
    assert.ok(balance <= 0, `${month.period}: a mortgage cannot go positive`);
    previous = balance;
  }
});

test('net worth is a plain sum, with debt carrying its own sign', () => {
  const run = runProjection(mortgageModel());
  const sheet = run.balanceSheet;

  assert.equal(sheet.netWorth, sumCents(Object.values(run.balances)),
    'no assets-minus-liabilities special case is needed');
  assert.ok(sheet.totalDebt > 0 && sheet.totalDebt < 300_000_00, 'some of the mortgage is paid off');
  assert.ok(sheet.assets.some((a) => a.id === 'house'));
  assert.ok(sheet.liabilities.some((l) => l.id === 'mortgage'));
});

test('a house appreciates without generating a tax bill', () => {
  const run = runProjection({ ...mortgageModel(), taxPacks: PACKS });

  assert.ok(run.balances.house > 400_000_00, 'the house appreciated');
  const houseGrowth = run.events.filter((e) => e.kind === 'growth' && e.account === 'house');
  assert.ok(houseGrowth.every((e) => e.taxableAmount === 0),
    'appreciation is not income until the house is sold');
});

/* ---- assets and sales ---- */

test('selling an asset turns a paper gain into cash and taxable income', () => {
  const model = simpleModel({
    horizon: { startDate: '2026-01-01', endDate: '2026-12-31' },
    openingBalances: {},
    taxPacks: PACKS,
    accounts: [
      { id: 'cash', name: 'Checking', kind: 'checking', openingBalance: 20_000_00 },
      { id: 'shares', name: 'Shares', kind: 'brokerage', openingBalance: 40_000_00 },
    ],
    sources: [
      aSource('asset', {
        id: 'shares', name: 'Shares', startDate: '2026-01-01',
        details: {
          account: 'shares', fromAccount: 'cash', contribution: 0, costBasis: 40_000_00,
          sale: { date: '2026-06-15', proceeds: 65_000_00, costsOfSale: 1_000_00, acquiredDate: '2020-01-01' },
        },
      }),
    ],
  });
  const run = runProjection(model, { resolveSources });

  // $65,000 less $1,000 of costs, less the $40,000 basis, is a $24,000 gain.
  const gain = run.events.find((e) => e.taxCategory === 'long_term_gains');
  assert.ok(gain, 'the sale should produce a long-term gain');
  assert.equal(gain.taxableAmount, 24_000_00);
  assert.equal(gain.cashAmount, 24_000_00);

  assert.equal(run.balances.shares, 0, 'the asset left the balance sheet');
  assert.equal(run.balances.cash, 20_000_00 + 64_000_00 - expectedSpending(run),
    'cash received the full net proceeds');
});

function expectedSpending(run) {
  return -sumCash(run.events, (e) => e.account === 'cash' && e.cashAmount < 0 && e.kind !== 'transfer');
}

test('holding period decides short versus long term', () => {
  const build = (acquiredDate) => simpleModel({
    horizon: { startDate: '2026-01-01', endDate: '2026-12-31' },
    openingBalances: {},
    sources: [
      aSource('asset', {
        id: 'flip', name: 'Quick trade', startDate: '2026-01-01',
        details: {
          account: 'flip', fromAccount: 'cash', costBasis: 10_000_00,
          sale: { date: '2026-06-15', proceeds: 15_000_00, costsOfSale: 0, acquiredDate },
        },
      }),
    ],
    accounts: [
      { id: 'cash', kind: 'checking', openingBalance: 10_000_00 },
      { id: 'flip', kind: 'brokerage', openingBalance: 10_000_00 },
    ],
  });

  const short = runProjection(build('2026-01-02'));
  const long = runProjection(build('2024-01-02'));

  assert.equal(short.events.find((e) => e.taxCategory)?.taxCategory, 'short_term_gains');
  assert.equal(long.events.find((e) => e.taxCategory)?.taxCategory, 'long_term_gains');
});

test('a sale with no purchase price is flagged rather than taxing the whole proceeds silently', () => {
  const model = simpleModel({
    horizon: { startDate: '2026-01-01', endDate: '2026-12-31' },
    sources: [
      aSource('asset', {
        id: 'mystery', name: 'Old shares', startDate: '2026-01-01',
        details: {
          account: 'mystery', fromAccount: 'cash', costBasis: null,
          sale: { date: '2026-06-15', proceeds: 50_000_00, costsOfSale: 0, acquiredDate: '2010-01-01' },
        },
      }),
    ],
  });
  const run = runProjection(model);
  assert.ok(run.warnings.some((w) => w.code === 'asset.no_cost_basis'));
});
