/**
 * "Why did this change?"
 *
 * This falls out of the event stream almost for free, but only because of two decisions
 * made much earlier:
 *
 *   1. Everything is an event, including the flows the engine invents. A tax payment or a
 *      sinking-fund transfer has a stable `sourceId`, so a diff can name it. Anything
 *      computed on the side would be invisible here.
 *   2. Money is integer cents. That is what lets the residual be EXACTLY zero rather than
 *      "close", which in turn makes it safe to assert — and an assertion that holds is the
 *      difference between an explanation and a plausible-looking guess.
 *
 * The residual check is the real test of the architecture. If `Σ deltas` ever fails to
 * equal `metricB - metricA`, something is producing money outside the event stream and
 * every downstream number is suspect.
 */

import { sumCents } from './money.js';

export class AttributionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttributionError';
    this.code = code;
  }
}

/**
 * Metrics that can be attributed.
 *
 * Every one is a sum over events matching a predicate, plus a constant from the opening
 * balances. A metric that cannot be written that way is not attributable, and the UI must
 * not offer it — a constraint that keeps the feature honest rather than letting it
 * degrade into a plausible-looking guess.
 */
export const METRICS = Object.freeze({
  netWorth: {
    label: 'Net worth',
    includes: () => true,
    opening: (run) => sumCents(Object.values(run.months[0]?.opening ?? {})),
  },
  liquidCash: {
    label: 'Liquid cash',
    includes: (event, run) => liquidAccounts(run).has(event.account),
    opening: (run) => {
      const liquid = liquidAccounts(run);
      return sumCents(
        Object.entries(run.months[0]?.opening ?? {})
          .filter(([account]) => liquid.has(account))
          .map(([, value]) => value),
      );
    },
  },
  cumulativeIncome: {
    label: 'Total income',
    includes: (event) => event.kind === 'income',
    opening: () => 0,
  },
  cumulativeExpense: {
    label: 'Total spending',
    includes: (event) => event.kind === 'expense',
    opening: () => 0,
  },
  taxPaid: {
    label: 'Tax paid',
    includes: (event) => event.kind === 'withholding' || event.kind === 'tax_payment' || event.kind === 'tax_refund',
    opening: () => 0,
  },
});

function liquidAccounts(run) {
  return new Set(run.liquidAccounts ?? ['cash', 'savings']);
}

const GROUPINGS = {
  source: (event) => event.sourceId,
  category: (event) => event.category,
  kind: (event) => event.kind,
};

/**
 * Compare two runs and explain the difference in one metric at one point in time.
 *
 * @param {Object} runA   the baseline
 * @param {Object} runB   the scenario
 * @param {Object} options
 * @param {string} [options.at]        'YYYY-MM'; defaults to the end of the horizon
 * @param {string} [options.metric='netWorth']
 * @param {string} [options.groupBy='source']
 * @param {number} [options.topN=6]
 */
export function attribute(runA, runB, options = {}) {
  const { at = null, metric = 'netWorth', groupBy = 'source', topN = 6 } = options;

  const spec = METRICS[metric];
  if (!spec) {
    throw new AttributionError('attribution.unknown_metric',
      `"${metric}" is not attributable (known: ${Object.keys(METRICS).join(', ')}). ` +
      'A metric must be expressible as a sum over events.');
  }
  const keyOf = GROUPINGS[groupBy];
  if (!keyOf) {
    throw new AttributionError('attribution.unknown_grouping', `cannot group by "${groupBy}"`);
  }

  const cutoff = at ?? lastPeriod(runB) ?? lastPeriod(runA);

  const bucketsA = bucket(runA, spec, keyOf, cutoff);
  const bucketsB = bucket(runB, spec, keyOf, cutoff);

  const totalA = spec.opening(runA) + sumCents([...bucketsA.values()]);
  const totalB = spec.opening(runB) + sumCents([...bucketsB.values()]);
  const openingDelta = spec.opening(runB) - spec.opening(runA);

  const lines = [];
  for (const key of new Set([...bucketsA.keys(), ...bucketsB.keys()])) {
    const delta = (bucketsB.get(key) ?? 0) - (bucketsA.get(key) ?? 0);
    if (delta === 0) continue;
    lines.push({
      key,
      delta,
      before: bucketsA.get(key) ?? 0,
      after: bucketsB.get(key) ?? 0,
      ...classify(key, bucketsA, bucketsB, runA, runB, groupBy),
    });
  }
  lines.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));

  /* The residual. If this is not zero, the architecture is broken, not the arithmetic. */
  const explained = sumCents(lines.map((l) => l.delta)) + openingDelta;
  const actual = totalB - totalA;
  const residual = actual - explained;

  if (residual !== 0) {
    lines.push({
      key: '<unexplained>',
      delta: residual,
      before: 0,
      after: 0,
      classification: 'unexplained',
      label: 'Unexplained',
      cause: null,
      note: 'This is a bug: some money is not coming from the event stream.',
    });
  }

  const shown = lines.slice(0, topN);
  const rest = lines.slice(topN);
  const remainder = rest.length > 0
    ? {
        key: '<other>',
        delta: sumCents(rest.map((l) => l.delta)),
        count: rest.length,
        classification: 'other',
        label: `everything else (${rest.length} item${rest.length === 1 ? '' : 's'})`,
      }
    : null;

  return Object.freeze({
    metric,
    metricLabel: spec.label,
    groupBy,
    at: cutoff,
    before: totalA,
    after: totalB,
    delta: actual,
    openingDelta,
    lines: shown,
    remainder,
    residual,
    incompleteScenario: (runB.overrideReport ?? []).filter((r) => r.status !== 'applied' && r.status !== 'shadowed'),
  });
}

function bucket(run, spec, keyOf, cutoff) {
  const out = new Map();
  for (const event of run.events) {
    if (event.period > cutoff) continue;
    if (!spec.includes(event, run)) continue;
    const key = keyOf(event);
    out.set(key, (out.get(key) ?? 0) + event.cashAmount);
  }
  return out;
}

/**
 * Work out WHY a bucket moved, and attach the override that caused it where there is one.
 *
 * Without this join the report is a diff table. With it, "$28,000 less salary" becomes
 * "$28,000 less salary — because Primary Job now ends 2026-10-31", which is the difference
 * between showing a number and explaining it.
 */
function classify(key, bucketsA, bucketsB, runA, runB, groupBy) {
  const inA = bucketsA.has(key);
  const inB = bucketsB.has(key);

  if (groupBy !== 'source') {
    return { classification: 'changed', label: key, cause: null, note: '' };
  }

  const sourceA = (runA.sourcesResolved ?? []).find((s) => s.id === key);
  const sourceB = (runB.sourcesResolved ?? []).find((s) => s.id === key);
  const label = sourceB?.name ?? sourceA?.name ?? key;

  const override = (runB.overrideReport ?? []).find((r) => r.sourceId === key && r.status === 'applied');
  const cause = override
    ? { path: override.path, before: override.before, after: override.after, note: override.note }
    : null;

  if (key.startsWith('system:')) {
    return { classification: 'derived', label: describeSystem(key), cause: null, note: 'a knock-on effect' };
  }
  if (!inA && inB) return { classification: 'added', label, cause, note: 'new in this scenario' };
  if (inA && !inB) {
    const omitted = (runB.omittedSourceIds ?? []).includes(key);
    return {
      classification: 'removed',
      label,
      cause,
      note: omitted ? 'did not happen in this run' : 'not in this scenario',
    };
  }

  if (!override && sourceA && sourceB && JSON.stringify(sourceA) === JSON.stringify(sourceB)) {
    return { classification: 'cascade', label, cause: null, note: 'changed as a knock-on effect' };
  }
  return { classification: 'changed', label, cause, note: '' };
}

function describeSystem(sourceId) {
  const known = {
    'system:tax-reserve-earmark': 'Tax reserve',
    'system:sinking-fund-autocover': 'Sinking-fund top-up',
  };
  return known[sourceId] ?? sourceId.replace(/^system:/, '').replace(/-/g, ' ');
}

function lastPeriod(run) {
  return run.months?.[run.months.length - 1]?.period ?? null;
}

/* -------------------------------------------------------------------------- */
/* Narrative                                                                   */
/* -------------------------------------------------------------------------- */

const money = (cents) =>
  (Math.abs(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/**
 * Render the report as text.
 *
 * Direction is carried by an explicit word AND a sign, never by colour alone — the same
 * sentence has to work in a screen reader and on a monochrome printout.
 */
export function renderAttribution(report) {
  const direction = report.delta === 0 ? 'unchanged' : report.delta < 0 ? 'lower' : 'higher';
  const headline = report.delta === 0
    ? `${report.metricLabel} in ${report.at} is unchanged.`
    : `${report.metricLabel} in ${report.at} is ${money(report.delta)} ${direction}.`;

  const lines = report.lines.map((line) => ({
    amount: line.delta,
    amountText: `${line.delta < 0 ? '−' : '+'}${money(line.delta)}`,
    label: line.label,
    reason: reasonFor(line),
    classification: line.classification,
  }));

  if (report.remainder) {
    lines.push({
      amount: report.remainder.delta,
      amountText: `${report.remainder.delta < 0 ? '−' : '+'}${money(report.remainder.delta)}`,
      label: report.remainder.label,
      reason: '',
      classification: 'other',
    });
  }

  const notes = [];
  if (report.incompleteScenario.length > 0) {
    notes.push(
      `${report.incompleteScenario.length} override${report.incompleteScenario.length === 1 ? '' : 's'} ` +
      'could not be applied, so this comparison is incomplete.',
    );
  }
  if (report.residual !== 0) {
    notes.push(`${money(report.residual)} is unexplained — this is a bug, not a rounding difference.`);
  }

  return { headline, lines, notes };
}

function reasonFor(line) {
  if (line.cause) {
    const { path, before, after, note } = line.cause;
    if (note) return note;
    return `${path}: ${format(before)} → ${format(after)}`;
  }
  return line.note ?? '';
}

function format(value) {
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) >= 1000 ? money(value) : String(value);
  return String(value);
}

/** Text rendering, for tests, the console, and the printable summary. */
export function attributionToText(report) {
  const { headline, lines, notes } = renderAttribution(report);
  const rows = lines.map((l) => `  ${l.amountText.padStart(10)}  ${l.label}${l.reason ? `  — ${l.reason}` : ''}`);
  return [headline, ...rows, ...notes.map((n) => `  ! ${n}`)].join('\n');
}
