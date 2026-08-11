/**
 * The written data model. Type declarations and documentation only — no runtime code.
 * If you want to understand this codebase, read this file first.
 *
 * ============================================================================
 * THE ONE RULE
 * ============================================================================
 *
 * Every number the app shows is a sum over a stream of atomic, signed, integer-cent
 * events — INCLUDING the numbers the engine itself invents. Withholding, estimated tax
 * payments, the April true-up, tax-reserve earmarks, sinking-fund transfers and
 * shortfall auto-covers are all real `Event` objects with real `sourceId`s
 * (`system:tax:federal:2026`, `system:sinking:exp_ins_001`), never values computed on
 * the side.
 *
 * That single rule buys four things:
 *   - Change attribution is nearly free. Diff two event streams grouped by source and the
 *     residual is exactly zero, so "why did net worth drop $42,600?" answers itself —
 *     including second-order effects, because tax is events too.
 *   - The month-close is `Σ cashAmount`, with no special cases.
 *   - The accessible data tables render the same object the charts render, so they cannot
 *     drift apart.
 *   - Monte Carlo (Phase 6) needs no contract change: the run is the unit of uncertainty.
 *
 * Corollary, and a hard rule: the engine never computes a displayed monetary figure that
 * is not a sum of events. If you find yourself writing `taxOwed - withheld` inline in a UI
 * module, the fix is to emit an event.
 *
 * ============================================================================
 * WHY THE EVENT FIELD LIST IS FROZEN
 * ============================================================================
 *
 * There will be steady pressure to add `withholding`, `netPay`, `employerMatch` or
 * `feeAmount` to the income event, because each one is locally convenient. Resist it.
 * A sub-amount bundled inside another event is invisible to attribution — a diff buckets
 * by event, so a change hidden in a field produces no line and no explanation. It also
 * forces the ledger to special-case, which breaks `closing === opening + Σ cashAmount`.
 *
 * These fields want to arrive as five small, reasonable pull requests, and together they
 * would quietly ruin the design. So `tests/event-shape.test.js` asserts the exact key set
 * of every event in every fixture: adding a field fails the build and forces an explicit
 * decision. The convenience you actually wanted lives in `events.js` as functions —
 * `netPayFor(events, groupId)`, `grossFor`, `withheldFor` — which read the group instead
 * of denormalising it.
 *
 * A paycheck is therefore three or four events sharing a `groupId`:
 *   gross pay          cash +8500.00   taxable +8500.00  w2_wages
 *   401(k) deferral    cash  -680.00   taxable  -680.00  pretax_deferral
 *   federal withheld   cash -1250.00   taxable     0.00
 *   FICA withheld      cash  -650.00   taxable     0.00
 *
 * ============================================================================
 * CASH IS NOT TAX IS NOT ACCOUNTING
 * ============================================================================
 *
 * `cashAmount` and `taxableAmount` are independent. Either can be zero while the other is
 * not, and they frequently differ in size. Getting this wrong is the most common way a
 * financial model produces confident, plausible, wrong answers.
 *
 *   Flow                        cashAmount                 taxableAmount
 *   ------------------------------------------------------------------------------
 *   W-2 gross pay               +gross                     +gross (w2_wages)
 *   Federal withholding         -W                         0
 *   FICA (employee side)        -F                         0
 *   Pre-tax 401(k) deferral     -D cash / +D retirement    -D (pretax_deferral)
 *   Roth contribution           -R cash / +R roth          0
 *   Employer match              0 cash / +M retirement     0   (not household cash)
 *   Checking -> brokerage       -X / +X                    0   NOT AN EXPENSE
 *   Estimated tax payment       -E                         0   NOT A DEDUCTION
 *   Mortgage principal          -P cash / +P debt paydown  0
 *   Mortgage interest           -I                         -I only where deductible
 *   Depreciation                0  (kind 'noncash')        -Dep (rental_net)
 *   Sinking-fund reserve        -S / +S                    0
 *   Tax-reserve earmark         -T / +T                    0
 *   Contract payment with lag   +C on the payment date     +C, same date (cash basis)
 *   Tax refund                  +R                         0
 *
 * ============================================================================
 * MONEY
 * ============================================================================
 *
 * All monetary values are signed integer CENTS. Floats appear only as rates and only as
 * input to `money.js`. See that module for why.
 */

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {'income'|'expense'|'transfer'|'contribution'|'withholding'|'tax_payment'
 *          |'tax_refund'|'debt_service'|'growth'|'noncash'|'adjustment'} EventKind
 *
 * income        Money earned or received.
 * expense       Consumption; leaves the household. A positive cashAmount here is a refund.
 * transfer      Between the household's own accounts. Net-worth neutral by construction.
 * contribution  Into a retirement/investment account. A transfer with tax semantics.
 * withholding   Tax withheld at source. Always reduces cash, never moves taxable income.
 * tax_payment   An estimated payment or a balance due. Reduces cash; not a deduction.
 * tax_refund    Prior-year over-withholding coming back.
 * debt_service  Interest and principal legs of a loan payment.
 * growth        Investment return, interest or appreciation on an account balance.
 *               Taxable only where the return is realised annually (savings interest);
 *               an unrealised gain on a brokerage or a property carries taxableAmount 0
 *               until it is sold.
 * noncash       Depreciation, accruals, basis adjustments. cashAmount is always 0.
 * adjustment    An engine correction, e.g. covering a sinking-fund shortfall. Always
 *               accompanied by a warning — the engine reports, it does not repair.
 */

/**
 * @typedef {'OPEN'|'INCOME_GROSS'|'PRETAX_DEDUCTION'|'WITHHOLDING'|'EXPENSE'
 *          |'DEBT_SERVICE'|'POSTTAX_CONTRIBUTION'|'TRANSFER'|'ESTIMATED_TAX'
 *          |'TAX_TRUE_UP'|'GROWTH'|'CLOSE'} Phase
 *
 * Intra-month ordering bucket.
 *
 * IMPORTANT, and worth reading before "fixing" a total by reordering phases: phase order
 * does NOT affect closing cash. Addition commutes. It affects exactly two things —
 * (a) the minimum intra-month cash and the date it occurs, and (b) close rules that read a
 * running balance. Phase order is a diagnostic-fidelity concern, not an arithmetic one.
 *
 * Note that PRETAX_DEDUCTION sorts above WITHHOLDING. Withholding is computed on wages net
 * of pre-tax deferrals, so the deferral leg has to land first or the ordering would imply
 * a wage reduction that has not happened yet.
 */

/**
 * @typedef {'w2_wages'|'se_net_profit'|'interest'|'ordinary_dividends'
 *          |'qualified_dividends'|'short_term_gains'|'long_term_gains'|'rental_net'
 *          |'retirement_distribution_ordinary'|'tax_exempt_interest'|'other_ordinary'
 *          |'pretax_deferral'|'above_line_deduction'} TaxCategory
 *
 * A closed enum. `pretax_deferral` and `above_line_deduction` carry NEGATIVE taxable
 * amounts. Adding a category means a rule-pack change plus one line in the category->bucket
 * map in `tax/federal.js` — never a bracket in code.
 */

/** @typedef {'certain'|'expected'|'won'|'lost'} Realization */

/**
 * A single atomic cash and/or tax effect. Frozen on creation; `realize()` returns new
 * objects rather than mutating.
 *
 * @typedef {Object} Event
 * @property {string} id             Deterministic: `${sourceId}:${date}:${phase}:${seq}`.
 * @property {string} sourceId       The source that produced it, or `system:*`.
 * @property {string|null} groupId   Ties the legs of one economic transaction together.
 * @property {string|null} personId  Which earner. Non-null for income and withholding,
 *                                   because the Social Security wage base is per person.
 * @property {string} date           Cash settlement date, 'YYYY-MM-DD'.
 * @property {string} period         'YYYY-MM'. Denormalised from `date`; the grouping key.
 * @property {EventKind} kind
 * @property {Phase} phase
 * @property {number} seq            Tie-break within (date, phase, sourceId). Integer >= 0.
 * @property {string} account        Account the cash lands in. Required, always.
 * @property {number} cashAmount     SIGNED integer cents. Effect on the account balance.
 * @property {number} taxableAmount  SIGNED integer cents. Independent of cashAmount.
 * @property {TaxCategory|null} taxCategory  Non-null iff taxableAmount !== 0.
 * @property {number|null} taxYear   Non-null iff taxableAmount !== 0.
 * @property {number} probability    0..1. Pre-realisation weight; 1 when certain.
 * @property {Realization} realization
 * @property {string} category       User-facing bucket: 'salary', 'housing', 'tax', ...
 * @property {boolean|null} essential    Expenses only; null otherwise.
 * @property {1|2|3|4|5|null} cutPriority Expenses only; null otherwise.
 * @property {string[]} tags         Sorted and deduped, so hashes are stable.
 * @property {string} label          Human string used in attribution narratives.
 * @property {Object} meta           Source-type-specific. THE ENGINE NEVER READS THIS.
 */

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How uncertain a source is.
 *
 * Phase 1-3 supports `fixed`, `probability` and `range`. `distribution` and
 * `correlationGroup` are declared now and unread until Phase 6, so that adding Monte Carlo
 * changes no other type.
 *
 * WHERE A RANGE ACTUALLY LIVES. `realize()` reads a range off the EVENT, as
 * `meta.range = {low, base, high}` in absolute cents for that occurrence — not off these
 * three fields. The reason is that one source produces many events of different sizes: a
 * royalty with an escalator, or a contract mid-raise, has a different low and high at
 * every occurrence, and a single triple on the source could not describe them. The source
 * fields below stay the user-facing way to say it once; a compiler turns them into a
 * per-event triple. See the two-kinds-of-uncertainty note at the top of `realize.js`.
 *
 * @typedef {Object} Certainty
 * @property {'fixed'|'probability'|'range'} mode
 * @property {number} confidence          0..1, used by 'probability'.
 * @property {number|null} low            cents, used by 'range'.
 * @property {number|null} base           cents, used by 'range'.
 * @property {number|null} high           cents, used by 'range'.
 * @property {Object|null} distribution   Phase 6.
 * @property {string|null} correlationGroup Phase 6.
 */

/**
 * A user-entered financial item. Type-specific settings live under `details`; the engine
 * never reads `details` — only that type's compiler does.
 *
 * @typedef {Object} Source
 * @property {string} id
 * @property {string} type            Key into the source-type registry.
 * @property {string} name
 * @property {boolean} enabled
 * @property {string|null} personId
 * @property {string} startDate       'YYYY-MM-DD'.
 * @property {string|null} endDate    null means open-ended.
 * @property {Certainty} certainty
 * @property {Object} details
 * @property {string} notes
 */

/**
 * Drives form rendering, override editors and validation from one declaration.
 *
 * @typedef {Object} FieldSpec
 * @property {string} path            Dotted path into the source, e.g. 'details.growthRate'.
 * @property {string} label
 * @property {'money'|'percent'|'date'|'text'|'select'|'bool'|'int'} kind
 * @property {boolean} [required]
 * @property {number} [min]
 * @property {number} [max]
 * @property {Array<{value:string,label:string}>} [options]
 * @property {string} [help]
 * @property {boolean} [advanced]     Hidden behind "Advanced options" in forms.
 */

/**
 * @typedef {Object} SourceTypeDef
 * @property {string} type
 * @property {string} label
 * @property {'income'|'expense'|'transfer'|'asset'|'liability'} family
 * @property {() => Source} defaults
 * @property {FieldSpec[]} fields
 * @property {string[]} overridablePaths  Allowlist a scenario override may target.
 * @property {(source: Source, ctx: CompileContext) => void} compile
 * @property {(source: Source) => Warning[]} check
 * @property {(source: Source) => string} describe
 */

/**
 * Handed to each compiler. Deliberately exposes no running balances, no other sources and
 * no clock: a compiler is a pure function of one source, which is what makes source order
 * irrelevant and results reproducible.
 *
 * @typedef {Object} CompileContext
 * @property {Horizon} horizon
 * @property {(partial: Partial<Event>) => Event} emit
 * @property {(groupId: string, partials: Partial<Event>[]) => Event[]} emitGroup
 * @property {(code: string, data?: Object) => void} warn
 * @property {Object} assumptions
 * @property {Object} rules
 * @property {Household} household
 * @property {Object} helpers
 */

/** @typedef {Object} Horizon
 * @property {string} startDate
 * @property {string} endDate
 * @property {string[]} months  Every 'YYYY-MM' in range, inclusive.
 */

/* -------------------------------------------------------------------------- */
/* Household, scenarios, runs                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Person
 * @property {string} id
 * @property {string} name
 * @property {number|null} birthYear   Drives catch-up contribution limits.
 */

/**
 * Two earners are modelled separately even when filing jointly, because the Social
 * Security wage base applies PER PERSON while the Additional Medicare threshold applies
 * PER RETURN. Pooling household earnings gets both wrong.
 *
 * @typedef {Object} Household
 * @property {'single'|'married_joint'|'married_separate'|'head_of_household'} filingStatus
 * @property {Person[]} people
 * @property {string} state
 * @property {number} dependents
 */

/**
 * @typedef {Object} Override
 * @property {string} id
 * @property {string} sourceId
 * @property {string} path            Dotted; must appear in the type's overridablePaths.
 * @property {'set'|'scale'|'delta'|'enable'|'disable'} op
 * @property {*} value
 * @property {string} note            Shown in the attribution narrative.
 */

/**
 * Scenarios are overrides on top of the base model, never a copy of it. A scenario with no
 * overrides must produce a byte-identical run to base — see `scenarios.js`, where the early
 * return is the proof rather than an optimisation.
 *
 * @typedef {Object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {'base'} basedOn
 * @property {Override[]} overrides
 * @property {Source[]} addedSources
 * @property {string[]} removedSourceIds
 * @property {Object} assumptionOverrides
 * @property {Object|null} presetOrigin
 */

/**
 * @typedef {Object} Warning
 * @property {string} code            Must exist in `warnings.js`.
 * @property {'info'|'warn'|'error'} severity
 * @property {string} message
 * @property {string|null} sourceId
 * @property {Object} data
 */

/**
 * One month's close.
 *
 * @typedef {Object} MonthResult
 * @property {string} period
 * @property {Object<string, number>} opening    Balance per account, cents.
 * @property {Object<string, number>} closing
 * @property {Object<string, number>} byKind     Σ cashAmount per EventKind.
 * @property {Object<string, number>} byCategory
 * @property {Object<string, number>} bySource   What makes attribution cheap.
 * @property {string[]} events                   Event ids, in order.
 */

/**
 * The output of one projection. Deterministic: the same model and options always produce
 * the same `runKey`.
 *
 * @typedef {Object} Run
 * @property {string} runKey
 * @property {Event[]} events
 * @property {MonthResult[]} months
 * @property {Object} yearResults
 * @property {Object} metrics
 * @property {Warning[]} warnings
 * @property {Object[]} overrideReport
 * @property {Source[]} sourcesResolved
 * @property {Realization} mode
 */

export {};
