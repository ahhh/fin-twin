/**
 * Close rules — logic that genuinely needs a running balance.
 *
 * Compilers cannot do this: they are pure functions of one source and never see a ledger.
 * A close rule may emit events; it may NOT emit taxable income, which `ledger.js` asserts.
 * That constraint is what keeps the two-pass engine non-circular.
 */

import { registerCloseRule } from './ledger.js';
import { scaleCents } from './money.js';
import { periodToISO } from './dates.js';

export const TAX_RESERVE_ACCOUNT = 'tax_reserve';
export const SINKING_PREFIX = 'sink_';

const money = (cents) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * Earmark a share of income that arrived without withholding.
 *
 * 1099 income is not withheld at source, so the cash sitting in the account is not all
 * spendable. Moving the tax share aside is what makes "spendable cash" honest.
 *
 * Modelled as a TRANSFER, not an expense: the money is still yours, just spoken for. That
 * also means it is net-worth neutral by construction.
 *
 * The rate can come from the user, or — once a tax pass has run — from the projected
 * effective rate on self-employment income, which is a far better estimate than a guess.
 */
export function registerTaxReserveRule() {
  return registerCloseRule({
    id: 'tax-reserve-earmark',
    order: 10,
    run(state, ctx) {
      const rate = reserveRateFor(state, ctx);
      if (rate <= 0) return;

      // Income with no withholding attached to its group.
      const withheldGroups = new Set(
        state.events.filter((e) => e.kind === 'withholding').map((e) => e.groupId),
      );
      const unwithheld = state.events.filter(
        (e) => e.kind === 'income' && e.taxableAmount > 0 && !withheldGroups.has(e.groupId),
      );
      if (unwithheld.length === 0) return;

      const base = unwithheld.reduce((sum, e) => sum + e.taxableAmount, 0);
      const reserve = scaleCents(base, rate);
      if (reserve <= 0) return;

      // Never earmark more than exists, or the reserve invents money the user does not
      // have and the cash line goes negative for a reason they cannot see.
      const available = state.balanceOf('cash');
      const amount = Math.min(reserve, Math.max(0, available));
      if (amount <= 0) return;

      const date = lastDateIn(state.events) ?? `${state.period}-01`;
      const groupId = `taxreserve:${state.period}`;

      ctx.emit({
        date, groupId, kind: 'transfer', phase: 'CLOSE', account: 'cash',
        cashAmount: -amount, category: 'tax',
        label: 'Tax reserve — set aside', tags: ['tax-reserve', 'transfer'], seq: 0,
      });
      ctx.emit({
        date, groupId, kind: 'transfer', phase: 'CLOSE', account: TAX_RESERVE_ACCOUNT,
        cashAmount: amount, category: 'tax',
        label: 'Tax reserve — held', tags: ['tax-reserve', 'transfer'], seq: 1,
      });
    },
  });
}

/**
 * Prefer the projected effective rate over a user guess.
 *
 * Once pass A has run, the year's actual effective rate on gross income is known, and it
 * is a much better reserve rate than the round number people usually pick. Falls back to
 * the entered rate when there are no tax results — which is the case before Milestone C's
 * packs are loaded.
 */
function reserveRateFor(state, ctx) {
  const entered = ctx.context.taxReserveRate ?? 0;
  if (!ctx.context.useProjectedTaxRate) return entered;

  const year = Number(state.period.slice(0, 4));
  const result = ctx.context.yearResults?.[year];
  if (!result || !result.grossIncome) return entered;

  // Only the part of the liability not already covered by withholding needs reserving.
  const unfunded = Math.max(0, result.totalLiability - result.withheld);
  return Math.min(1, unfunded / result.grossIncome);
}

/**
 * Cover a sinking-fund shortfall from cash, visibly.
 *
 * When the reserve has not built up enough by the time the bill lands, the engine covers
 * the difference so the projection stays meaningful — but it emits a real `adjustment`
 * event and a warning, so the top-up is a row the user can see rather than a silent fix.
 */
export function registerSinkingAutocoverRule() {
  return registerCloseRule({
    id: 'sinking-fund-autocover',
    order: 5,
    run(state, ctx) {
      for (const [account, balance] of Object.entries(state.balances)) {
        if (!account.startsWith(SINKING_PREFIX) || balance >= 0) continue;

        const shortfall = -balance;
        const bill = state.events.find(
          (e) => e.account === account && e.kind === 'expense',
        );
        const date = bill?.date ?? lastDateIn(state.events) ?? `${state.period}-01`;
        const groupId = `autocover:${account}:${state.period}`;

        ctx.warn('sinking.autocover', {
          fund: account.replace(SINKING_PREFIX, ''),
          shortfall: money(shortfall),
          label: bill?.label ?? 'a bill',
          date,
        });

        ctx.emit({
          date, groupId, kind: 'adjustment', phase: 'CLOSE', account: 'cash',
          cashAmount: -shortfall, category: 'transfer',
          label: `Topped up ${account.replace(SINKING_PREFIX, '')} reserve`,
          tags: ['autocover', 'adjustment'], seq: 0,
        });
        ctx.emit({
          date, groupId, kind: 'adjustment', phase: 'CLOSE', account,
          cashAmount: shortfall, category: 'transfer',
          label: `${account.replace(SINKING_PREFIX, '')} reserve topped up from cash`,
          tags: ['autocover', 'adjustment'], seq: 1,
        });
      }
    },
  });
}

/** Track when liquid cash ends a month below the emergency target. */
export function registerEmergencyTargetRule() {
  return registerCloseRule({
    id: 'emergency-target-watch',
    order: 90,
    run(state, ctx) {
      const target = ctx.context.emergencyTargetCents ?? 0;
      if (target <= 0) return;
      if (state.liquid() >= target) return;
      if (ctx.context.emergencyWarned?.has(state.period)) return;

      ctx.context.emergencyWarned?.add(state.period);
      ctx.warn('cash.below_emergency_target', {
        period: state.period,
        months: ctx.context.emergencyTargetMonths ?? 3,
      });
    },
  });
}

/**
 * Compound each account's expected return onto its balance.
 *
 * A close rule rather than a compiler, because the return depends on the balance, which
 * changes every month as money goes in and out. A compiler cannot see a balance.
 *
 * Whether the growth is TAXABLE is the part that matters. Interest on savings is taxable
 * in the year it is earned; a brokerage or a house appreciating is not taxable until it is
 * sold. Emitting taxable growth is what makes the projection a fixed point — see the loop
 * in engine.js.
 */
export function registerGrowthRule() {
  return registerCloseRule({
    id: 'account-growth',
    order: 20,
    run(state, ctx) {
      const accounts = ctx.context.accounts ?? {};

      for (const account of Object.values(accounts)) {
        if (!account.expectedReturn) continue;
        // Debt interest is handled by the loan's own amortisation, which needs the
        // payment schedule as well as the rate.
        if (account.family === 'liability') continue;

        const balance = state.balanceOf(account.id);
        if (balance === 0) continue;

        // Geometric monthly rate, so twelve months compound to the annual figure exactly
        // rather than to annual/12 twelve times.
        const monthlyRate = (1 + account.expectedReturn) ** (1 / 12) - 1;
        const growth = scaleCents(balance, monthlyRate);
        if (growth === 0) continue;

        const taxable = account.growthTaxCategory !== null;
        const date = periodToISO(state.period, 'last');

        ctx.emit({
          date,
          kind: 'growth',
          phase: 'GROWTH',
          account: account.id,
          cashAmount: growth,
          taxableAmount: taxable ? growth : 0,
          taxCategory: taxable ? account.growthTaxCategory : null,
          personId: taxable ? account.personId : null,
          category: taxable ? 'interest' : 'investment-return',
          label: taxable
            ? `${account.name} — interest`
            : `${account.name} — return (unrealised until sold)`,
          tags: taxable ? ['growth', 'interest', 'taxable'] : ['growth', 'unrealised'],
          seq: 0,
        });
      }
    },
  });
}

/** Register every built-in close rule. Call once at start-up. */
export function registerBuiltInCloseRules() {
  registerSinkingAutocoverRule();
  registerTaxReserveRule();
  registerGrowthRule();
  registerEmergencyTargetRule();
}

function lastDateIn(events) {
  let latest = null;
  for (const event of events) if (latest === null || event.date > latest) latest = event.date;
  return latest;
}
