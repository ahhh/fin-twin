/**
 * Loans and amortisation.
 *
 * A loan payment is three legs sharing a groupId:
 *
 *   interest    cash      −I
 *   principal   cash      −P
 *   principal   liability +P     (the debt shrinks toward zero)
 *
 * Cash falls by the full payment; net worth falls by the INTEREST only, because the
 * principal moved from one account to another. That is the whole economic story of a loan
 * payment, and it falls out of the event model without a special case.
 *
 * Amortisation is computed here, in the compiler, even though it needs a running balance —
 * because it needs *its own* balance, which is a closed-form function of the principal,
 * the rate and the payment. It never reads the ledger, so the compiler stays pure and
 * source order stays irrelevant.
 */

import { registerSourceType } from './registry.js';
import { makeWarning } from '../warnings.js';
import { expandSchedule } from '../recurrence.js';
import { roundHalfAwayFromZero, scaleCents } from '../money.js';

export const LOAN_DEFAULTS = Object.freeze({
  principal: 0,
  annualRate: 0.06,
  termMonths: 360,
  payment: null,          // null = derive it from the term
  liabilityAccount: '',   // defaults to the source id
  fromAccount: 'cash',
  extraPayment: 0,
  anchorDay: 1,
  deductibleInterest: false,
});

const FIELDS = [
  { path: 'name', label: 'What it is', kind: 'text', required: true },
  { path: 'details.principal', label: 'Amount owed now', kind: 'money', required: true, min: 0,
    help: 'Enter what you owe as a positive number.' },
  { path: 'details.annualRate', label: 'Interest rate', kind: 'percent', required: true, min: 0, max: 1 },
  { path: 'details.termMonths', label: 'Months remaining', kind: 'int', min: 1, max: 600 },
  { path: 'details.payment', label: 'Monthly payment', kind: 'money', min: 0,
    help: 'Leave blank to work it out from the term.' },
  { path: 'details.extraPayment', label: 'Extra each month', kind: 'money', min: 0,
    help: 'Paid straight off the principal, shortening the loan.' },
  { path: 'startDate', label: 'First payment', kind: 'date', required: true },
  { path: 'endDate', label: 'Stop paying after', kind: 'date', advanced: true,
    help: 'Leave blank to run until the loan is cleared.' },
  { path: 'details.deductibleInterest', label: 'Interest may be deductible', kind: 'bool', advanced: true,
    help: 'Mortgage interest often is; a car loan generally is not. This version records the flag but does not itemise.' },
  { path: 'details.fromAccount', label: 'Paid from', kind: 'text', advanced: true },
  { path: 'details.liabilityAccount', label: 'Debt account', kind: 'text', advanced: true },
  { path: 'details.anchorDay', label: 'Day of month', kind: 'int', min: 1, max: 31, advanced: true },
];

/**
 * The level payment that clears `principal` over `months` at `monthlyRate`.
 *
 *   payment = P · r / (1 − (1+r)^−n)
 *
 * Rounded UP to the cent, which is what lenders do and which matters more than it looks.
 * Rounding to nearest leaves a residue: $300,000 at 6% over 360 months comes to
 * $1,798.6512, and paying $1,798.65 leaves $1.44 outstanding after the final payment — so
 * the loan needs a 361st month of $1.45. Technically correct, and it reads as a bug in a
 * projection. Rounding up costs a cent a month and clears the loan in exactly its term,
 * with a slightly smaller final payment.
 */
export function levelPayment(principalCents, monthlyRate, months) {
  if (months <= 0) return principalCents;
  if (monthlyRate === 0) return Math.ceil(principalCents / months);
  const factor = monthlyRate / (1 - (1 + monthlyRate) ** -months);
  return Math.ceil(principalCents * factor);
}

/**
 * Walk the loan down month by month.
 *
 * The final payment is trimmed to whatever is actually left, so the balance lands on
 * exactly zero rather than a few cents either side — a loan that ends owing −$0.03 would
 * quietly corrupt net worth for the rest of the projection.
 */
export function amortise({ principal, monthlyRate, payment, extra = 0, maxMonths = 1200 }) {
  const schedule = [];
  let balance = principal;

  for (let month = 0; month < maxMonths && balance > 0; month++) {
    const interest = scaleCents(balance, monthlyRate);
    let principalPart = payment + extra - interest;

    if (principalPart <= 0) {
      // The payment does not even cover the interest: the debt grows forever.
      return { schedule, neverAmortises: true, monthsToPayoff: null, totalInterest: null };
    }

    if (principalPart > balance) principalPart = balance;
    balance -= principalPart;

    schedule.push({ month, interest, principal: principalPart, payment: interest + principalPart, balance });
  }

  return {
    schedule,
    neverAmortises: false,
    monthsToPayoff: schedule.length,
    totalInterest: schedule.reduce((sum, row) => sum + row.interest, 0),
  };
}

function check(source) {
  const warnings = [];
  const d = { ...LOAN_DEFAULTS, ...source.details };

  if (d.principal < 0) {
    warnings.push(makeWarning('source.negative_amount', { name: source.name, field: 'amount owed' }, source.id));
  }
  if (d.principal === 0) {
    warnings.push(makeWarning('source.zero_amount', { name: source.name }, source.id));
    return warnings;
  }

  const monthlyRate = d.annualRate / 12;
  const payment = d.payment ?? levelPayment(d.principal, monthlyRate, d.termMonths);
  if (payment + d.extraPayment <= scaleCents(d.principal, monthlyRate)) {
    warnings.push(makeWarning('loan.never_amortises', {
      name: source.name,
      payment: money(payment + d.extraPayment),
      interest: money(scaleCents(d.principal, monthlyRate)),
    }, source.id));
  }
  return warnings;
}

const money = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function compile(source, ctx) {
  const d = { ...LOAN_DEFAULTS, ...source.details };
  if (d.principal === 0) return;

  const liabilityAccount = d.liabilityAccount || source.id;
  const monthlyRate = d.annualRate / 12;
  const payment = d.payment ?? levelPayment(d.principal, monthlyRate, d.termMonths);

  const { schedule, neverAmortises } = amortise({
    principal: d.principal,
    monthlyRate,
    payment,
    extra: d.extraPayment,
    maxMonths: ctx.horizon.months.length + 1,
  });

  if (neverAmortises) {
    ctx.warn('loan.never_amortises', {
      payment: money(payment + d.extraPayment),
      interest: money(scaleCents(d.principal, monthlyRate)),
    });
    return;
  }

  // One payment date per scheduled month, from the loan's start.
  const dates = expandSchedule({
    start: source.startDate,
    end: source.endDate,
    frequency: 'monthly',
    anchorDay: d.anchorDay,
    windowStart: ctx.horizon.startDate,
    windowEnd: ctx.horizon.endDate,
  });

  // Payments before the horizon still advance the loan, so the balance is right when the
  // projection picks it up. Work out how many were missed.
  const skipped = countPaymentsBefore(source, d, ctx);

  dates.forEach((date, index) => {
    const row = schedule[index + skipped];
    if (!row) return; // the loan is paid off

    const groupId = `loan:${source.id}:${date}`;

    if (row.interest > 0) {
      ctx.emit({
        date, groupId, kind: 'debt_service', phase: 'DEBT_SERVICE', account: d.fromAccount,
        cashAmount: -row.interest, category: 'debt',
        label: `${source.name} — interest`,
        tags: d.deductibleInterest ? ['debt', 'interest', 'deductible-candidate'] : ['debt', 'interest'],
        meta: { deductibleInterest: d.deductibleInterest },
      });
    }

    // The two principal legs. Together they leave net worth unchanged; only the interest
    // above is a real cost.
    ctx.emit({
      date, groupId, kind: 'debt_service', phase: 'DEBT_SERVICE', account: d.fromAccount,
      cashAmount: -row.principal, category: 'debt',
      label: `${source.name} — principal`, tags: ['debt', 'principal'],
    });
    ctx.emit({
      date, groupId, kind: 'debt_service', phase: 'DEBT_SERVICE', account: liabilityAccount,
      cashAmount: row.principal, category: 'debt',
      label: `${source.name} — balance reduced`, tags: ['debt', 'principal'],
    });
  });
}

/** Payments falling between the loan's start and the projection's — already made. */
function countPaymentsBefore(source, d, ctx) {
  if (source.startDate >= ctx.horizon.startDate) return 0;
  return expandSchedule({
    start: source.startDate,
    end: ctx.horizon.startDate,
    frequency: 'monthly',
    anchorDay: d.anchorDay,
    windowStart: source.startDate,
    windowEnd: ctx.horizon.startDate,
  }).length - 1;
}

function describe(source) {
  const d = { ...LOAN_DEFAULTS, ...source.details };
  const payment = d.payment ?? levelPayment(d.principal, d.annualRate / 12, d.termMonths);
  return `${money(d.principal)} at ${(d.annualRate * 100).toFixed(2)}%, ${money(payment)} a month`;
}

export const loanType = registerSourceType({
  type: 'loan',
  complexity: 'advanced',
  label: 'Loan or mortgage',
  family: 'liability',
  fields: FIELDS,
  overridablePaths: [
    'name', 'startDate', 'endDate',
    'details.principal', 'details.annualRate', 'details.termMonths', 'details.payment',
    'details.extraPayment', 'details.deductibleInterest',
  ],
  defaults: () => ({
    id: '', type: 'loan', name: 'New loan', enabled: true, personId: null,
    startDate: '', endDate: null,
    certainty: { mode: 'fixed', confidence: 1, low: null, base: null, high: null, distribution: null, correlationGroup: null },
    details: { ...LOAN_DEFAULTS },
    notes: '',
  }),
  compile,
  check,
  describe,
});
