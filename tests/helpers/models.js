/**
 * Model fixtures.
 *
 * `sliceModel` is the §37 vertical slice from the plan and the fixture most tests use:
 * starting cash, a salary that ends, a second that starts later, an essential recurring
 * expense, one uncertain contract, and a tax-reserve rule.
 */

import { getSourceType } from '../../model/sources/index.js';

/** Build a source from its type defaults, so fixtures only state what they mean. */
export function aSource(type, overrides = {}) {
  const base = getSourceType(type).defaults();
  const { details, certainty, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    certainty: { ...base.certainty, ...certainty },
    details: { ...base.details, ...details },
  };
}

export const PERSON = { id: 'p1', name: 'Alex', birthYear: 1990 };

export function sliceModel(overrides = {}) {
  return {
    schemaVersion: 1,
    household: { filingStatus: 'single', people: [PERSON], state: 'CO', dependents: 0 },
    horizon: { startDate: '2026-01-01', endDate: '2027-12-31' },
    openingBalances: { cash: 20_000_00 },
    liquidAccounts: ['cash', 'savings'],
    taxReserveRate: 0.3,
    sources: [
      aSource('salary', {
        id: 'job_first',
        name: 'First Job',
        personId: 'p1',
        startDate: '2026-01-01',
        endDate: '2026-06-30',
        details: {
          annualAmount: 120_000_00,
          frequency: 'semimonthly',
          growthRate: 0,
          preTaxRate: 0,
          federalWithholdingRate: 0.18,
          ficaRate: 0.0765,
        },
      }),
      aSource('salary', {
        id: 'job_second',
        name: 'Second Job',
        personId: 'p1',
        startDate: '2026-10-01',
        endDate: null,
        details: {
          annualAmount: 140_000_00,
          frequency: 'semimonthly',
          growthRate: 0,
          preTaxRate: 0.08,
          federalWithholdingRate: 0.18,
          ficaRate: 0.0765,
        },
      }),
      aSource('expense', {
        id: 'exp_living',
        name: 'Living costs',
        startDate: '2026-01-01',
        details: {
          // Sized so the three-month gap between jobs actually eats into the reserve.
          // A slice that never gets tight would not exercise the runway logic.
          amount: 6_500_00,
          frequency: 'monthly',
          category: 'housing',
          essential: true,
          cutPriority: 5,
          inflationRate: 0,
        },
      }),
      aSource('contract', {
        id: 'contract_acme',
        name: 'Acme project',
        personId: 'p1',
        startDate: '2026-08-31',
        endDate: '2026-08-31',
        certainty: { mode: 'probability', confidence: 0.6 },
        details: {
          amount: 40_000_00,
          frequency: 'once',
          paymentLagDays: 45,
        },
      }),
    ],
    ...overrides,
  };
}

/** The simplest possible model: one salary, one expense, nothing uncertain. */
export function simpleModel(overrides = {}) {
  return {
    schemaVersion: 1,
    household: { filingStatus: 'single', people: [PERSON], state: 'CO', dependents: 0 },
    horizon: { startDate: '2026-01-01', endDate: '2026-12-31' },
    openingBalances: { cash: 10_000_00 },
    taxReserveRate: 0,
    sources: [
      aSource('salary', {
        id: 'job_only', name: 'Only Job', personId: 'p1', startDate: '2026-01-01',
        details: {
          annualAmount: 120_000_00, frequency: 'monthly', growthRate: 0,
          preTaxRate: 0, federalWithholdingRate: 0.2, ficaRate: 0.0765,
        },
      }),
      aSource('expense', {
        id: 'exp_rent', name: 'Rent', startDate: '2026-01-01',
        details: { amount: 2_600_00, frequency: 'monthly', category: 'housing', essential: true, inflationRate: 0 },
      }),
    ],
    ...overrides,
  };
}
