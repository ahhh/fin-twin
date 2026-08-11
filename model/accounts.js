/**
 * Accounts — including liabilities.
 *
 * The decision that makes the balance sheet almost free: **a liability is an account with
 * a negative balance.** A mortgage of $300,000 is an account holding −$30,000,000 cents.
 * Paying $1,200 of principal is one event moving −$1,200 from cash and one moving +$1,200
 * into the mortgage account.
 *
 * Everything follows from that:
 *   - Net worth is `Σ balances`, with no assets-minus-liabilities special case.
 *   - "Principal repayment reduces cash and debt equally" is true by construction, not by
 *     a rule someone has to remember.
 *   - The balance identity in `ledger.js` already covers debt, unchanged.
 *   - Attribution buckets debt like anything else.
 *
 * The alternative — a separate liabilities collection — would need every one of those to
 * be re-implemented and kept in step.
 */

export class AccountError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

/**
 * What each kind of account means to the engine.
 *
 * `growthTaxCategory` is the important one. Interest on savings is taxable in the year it
 * is earned; a brokerage or a house appreciating is NOT taxable until it is sold. Getting
 * that wrong either invents a tax bill or hides one.
 */
export const ACCOUNT_KINDS = Object.freeze({
  checking: {
    label: 'Checking', family: 'asset', liquid: true,
    growthTaxCategory: 'interest', taxTreatment: 'taxable',
  },
  savings: {
    label: 'Savings', family: 'asset', liquid: true,
    growthTaxCategory: 'interest', taxTreatment: 'taxable',
  },
  brokerage: {
    label: 'Taxable investments', family: 'asset', liquid: false,
    // Unrealised. Becomes taxable only on sale, as a capital gain.
    growthTaxCategory: null, taxTreatment: 'taxable',
  },
  traditional_retirement: {
    label: 'Traditional retirement', family: 'asset', liquid: false,
    growthTaxCategory: null, taxTreatment: 'tax_deferred',
  },
  roth_retirement: {
    label: 'Roth retirement', family: 'asset', liquid: false,
    growthTaxCategory: null, taxTreatment: 'tax_free',
  },
  hsa: {
    label: 'HSA', family: 'asset', liquid: false,
    growthTaxCategory: null, taxTreatment: 'tax_free',
  },
  property: {
    label: 'Property', family: 'asset', liquid: false,
    growthTaxCategory: null, taxTreatment: 'taxable',
  },
  vehicle: {
    label: 'Vehicle', family: 'asset', liquid: false,
    growthTaxCategory: null, taxTreatment: 'taxable',
  },
  other_asset: {
    label: 'Other asset', family: 'asset', liquid: false,
    growthTaxCategory: null, taxTreatment: 'taxable',
  },

  mortgage: { label: 'Mortgage', family: 'liability', liquid: false, deductibleInterest: true },
  heloc: { label: 'Home equity line', family: 'liability', liquid: false, deductibleInterest: true },
  student_loan: { label: 'Student loan', family: 'liability', liquid: false, deductibleInterest: false },
  auto_loan: { label: 'Car loan', family: 'liability', liquid: false, deductibleInterest: false },
  credit_card: { label: 'Credit card', family: 'liability', liquid: false, deductibleInterest: false },
  personal_loan: { label: 'Personal loan', family: 'liability', liquid: false, deductibleInterest: false },
  other_debt: { label: 'Other debt', family: 'liability', liquid: false, deductibleInterest: false },

  // Engine-owned. Money set aside but still yours.
  reserve: { label: 'Reserve', family: 'asset', liquid: false, growthTaxCategory: null, taxTreatment: 'taxable' },
});

export const isLiabilityKind = (kind) => ACCOUNT_KINDS[kind]?.family === 'liability';
export const isAssetKind = (kind) => ACCOUNT_KINDS[kind]?.family === 'asset';

export function accountKind(kind) {
  const def = ACCOUNT_KINDS[kind];
  if (!def) {
    throw new AccountError('account.unknown_kind',
      `no account kind "${kind}" (known: ${Object.keys(ACCOUNT_KINDS).join(', ')})`);
  }
  return def;
}

/**
 * Normalise an account definition.
 *
 * A liability's balance is stored NEGATIVE. Users think in positive debt ("I owe
 * $300,000"), so the form takes a positive number and this is where the sign is applied —
 * exactly once, in one place.
 */
export function makeAccount(partial) {
  const kind = partial.kind ?? 'checking';
  const def = accountKind(kind);

  const raw = partial.openingBalance ?? 0;
  const openingBalance = def.family === 'liability' ? -Math.abs(raw) : raw;

  return Object.freeze({
    id: partial.id,
    name: partial.name ?? def.label,
    kind,
    family: def.family,
    openingBalance,
    // Annual rate. On a liability this is the interest rate, applied by the loan source
    // rather than by the growth rule — amortisation needs the payment schedule too.
    expectedReturn: partial.expectedReturn ?? 0,
    liquid: partial.liquid ?? def.liquid,
    growthTaxCategory: partial.growthTaxCategory ?? def.growthTaxCategory ?? null,
    taxTreatment: partial.taxTreatment ?? def.taxTreatment ?? 'taxable',
    // Growth on a taxable account is booked to this person, since tax is per person.
    personId: partial.personId ?? null,
    notes: partial.notes ?? '',
  });
}

/** id -> account, for the ledger context. */
export function accountMap(accounts = []) {
  const out = Object.create(null);
  for (const account of accounts) {
    const normalised = makeAccount(account);
    if (out[normalised.id]) {
      throw new AccountError('account.duplicate_id', `two accounts share the id "${normalised.id}"`);
    }
    out[normalised.id] = normalised;
  }
  return out;
}

/**
 * Opening balances, merging the account list with the older `openingBalances` map.
 *
 * Both are supported so a model saved before accounts existed still loads. Where both name
 * the same account, the account definition wins — it is the richer statement.
 */
export function openingBalancesFrom(model, accounts) {
  const out = { ...(model.openingBalances ?? {}) };
  for (const account of Object.values(accounts)) out[account.id] = account.openingBalance;
  return out;
}

/** Accounts that count as spendable liquidity. */
export function liquidAccountsFrom(model, accounts) {
  const declared = Object.values(accounts).filter((a) => a.liquid).map((a) => a.id);
  if (declared.length > 0) return declared;
  return model.liquidAccounts ?? ['cash', 'savings'];
}

/** Default accounts for a new model. */
export function defaultAccounts() {
  return [
    makeAccount({ id: 'cash', name: 'Checking', kind: 'checking', openingBalance: 0 }),
    makeAccount({ id: 'savings', name: 'Savings', kind: 'savings', openingBalance: 0, expectedReturn: 0.03 }),
  ];
}

/* -------------------------------------------------------------------------- */
/* Balance-sheet views                                                         */
/* -------------------------------------------------------------------------- */

/** Split balances into assets and debts. Debts are reported POSITIVE for display. */
export function balanceSheet(balances, accounts) {
  const assets = [];
  const liabilities = [];

  for (const [id, balance] of Object.entries(balances)) {
    const account = accounts[id];
    const family = account?.family ?? (balance < 0 ? 'liability' : 'asset');
    const entry = {
      id,
      name: account?.name ?? id,
      kind: account?.kind ?? null,
      balance,
      liquid: account?.liquid ?? false,
    };
    if (family === 'liability') liabilities.push({ ...entry, owed: -balance });
    else assets.push(entry);
  }

  assets.sort((a, b) => b.balance - a.balance);
  liabilities.sort((a, b) => b.owed - a.owed);

  const totalAssets = assets.reduce((sum, a) => sum + a.balance, 0);
  const totalDebt = liabilities.reduce((sum, l) => sum + l.owed, 0);

  return {
    assets,
    liabilities,
    totalAssets,
    totalDebt,
    // Net worth is simply the sum of every balance, debts included with their own sign.
    netWorth: totalAssets - totalDebt,
    liquidAssets: assets.filter((a) => a.liquid).reduce((sum, a) => sum + a.balance, 0),
  };
}
