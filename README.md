# Financial Digital Twin

A local-first tool for modelling a household's financial life on a monthly timeline —
income, expenses, taxes, and scenarios — and seeing immediately what changes when you change
an assumption, along with *why* it changed.

It is built for the case most budgeting tools handle badly: **irregular income.** Contracting,
royalties, rental property, commissions, windfalls — money that arrives late, in lumps, and
without certainty. The questions it aims to answer are *when does cash get tight* and *how much
of this money is actually mine after tax*.

## Disclaimer

> Financial Digital Twin is an educational planning and scenario-modelling tool.
>
> It does not provide tax, legal, accounting, or investment advice and is not tax preparation
> software. Tax calculations are estimates based on configurable rules and user-entered
> assumptions. Tax laws and financial circumstances change. Verify important decisions with
> authoritative sources and qualified professionals.
>
> By default, data is stored locally in your browser. Exported files may contain sensitive
> financial information; store them securely.

## Running it locally

The app is a build-less ES-module site. It cannot run from `file://` — ES module imports and
`fetch()` of the tax rule packs both require an origin. So:

```sh
node tools/serve.mjs      # -> http://localhost:8080
```

There is no build step, no bundler, and no dependencies to install. Deployment is `git push`;
GitHub Pages serves the repository root as-is.

## Tests

```sh
node --test                # the whole suite
npm run test:tz            # re-runs it at UTC+14 and UTC-11
```

The timezone run is not paranoia. `new Date('2026-08-31')` parses as UTC midnight while
`.getMonth()` reads local time, so west of UTC a monthly salary can silently emit 59 or 61
paychecks over five years. Running the suite at both extremes catches that class of bug in one
line of config.

Three of the tests are architectural guards rather than behaviour tests:

| Test | Enforces |
|---|---|
| `no-network.test.js` | No shipped first-party file references an external origin or uses a network API outside a small allowlist. The footer's "your data stays in this browser" is a property of the code, not a promise in the copy. |
| `no-hardcoded-tax.test.js` | No tax constant lives in `model/tax/*.js`. Brackets, limits and thresholds are data in `data/tax/**`, versioned and dated. |
| `no-date-outside-dates.test.js` | `Date` is constructed in exactly one place. All date arithmetic is integer arithmetic on `YYYY-MM-DD` strings. |

They are cheap, and they enforce rules that code review otherwise erodes.

## Dependencies

None, and there will not be any. Chart.js is **vendored** into `vendor/` at a pinned version
and hash-checked by `tests/vendor.test.js`, so the page makes no CDN request at runtime and the
privacy claim stays literally true. `package.json` exists only so Node runs `.js` files as ES
modules under `node --test`; it is not a build step.

## What it does today

- **Multi-source cash flow** on a monthly timeline — salaried jobs (with the real 26/27
  paycheck years), contract work with payment lag and probability, expenses, transfers.
- **The irregular-income types the tool was built for.** Royalties, reported quarterly and
  paid a quarter later, sized as a range rather than a guess. Rent and fixed contracts with
  the void months named rather than smeared into an average vacancy rate. Windfalls, where
  the choice between an inheritance and a lottery win is the difference between no tax and
  a great deal of it. Investment income split across interest, ordinary and qualified
  dividends, and municipal interest that is never taxed.
- **Life-event scenarios** — a child, starting a family, buying a house, serious illness.
  These add real, editable items to the plan (a mortgage, childcare, the medical
  out-of-pocket maximum) rather than applying a multiplier you cannot inspect.
- **A real federal tax estimate**, driven by versioned rule packs rather than a flat rate:
  2026 brackets for all four filing statuses, standard deduction, FICA, self-employment tax
  with wage-base coordination, Additional Medicare per return, safe-harbour estimated
  payments and the April true-up.
- **Uncertainty as a first-class thing.** Anything uncertain produces three runs — if it
  lands, blended, if it does not — and the blended one is never shown alone.
- **Sinking funds** that spread an irregular bill into a monthly reserve without
  double-counting it, and say so when there was not enough runway to save.
- **Scenarios as overrides**, with presets that write visible, editable changes.
- **Change attribution**: every comparison explains itself, down to the last cent.
- **A phone layout with nothing removed.** Below 720px the sidebar becomes a bottom tab
  bar, tiles pack two-up, charts shorten, and the wide data tables pin their month column
  while the figures scroll. Touch targets and input sizes key off `pointer: coarse`, not
  the user agent.

Not built yet: the balance sheet and loan amortisation, CPA/planner exports, Monte Carlo,
state tax packs, capital gains, QBI.

## Architecture in one paragraph

Every financial item compiles into a stream of atomic, signed, **integer-cent** events.
Charts, totals, the tax engine, exports and scenario comparison all consume that one stream.
Crucially, the numbers the engine itself invents — withholding, estimated tax payments, the
April true-up, sinking-fund transfers — are real events with real source IDs, not values
computed on the side. That single rule is what makes change attribution nearly free, makes the
month-close a one-line sum, and makes the accessible data tables a view of the same object the
charts render rather than a second code path that can drift.

See `model/types.js` for the written data model, and the plan in
`~/.claude/plans/financial-digital-twin-resilient-scone.md` for the full design.

## Your data

Stored in this browser's `localStorage` and nowhere else. That also means **one cleared-site-data
click and it is gone.** Export your model to JSON regularly and keep it in your own backups.

## Licence

MIT. Chart.js is MIT, vendored with its licence in `vendor/chart.LICENSE.md`.
