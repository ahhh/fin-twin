/**
 * Scenarios as overrides on the base model — never as a copy of it.
 *
 * Overrides are applied BEFORE compilation, on a deep clone. Nothing downstream knows
 * scenarios exist: `compileAll` receives a plain array of sources and cannot tell which
 * scenario produced it. That is the property guaranteeing a scenario can only change the
 * result through the resolved source list, and it is what makes "why did this change?"
 * answerable by diffing two runs.
 *
 * A scenario with no overrides must produce a byte-identical run to base. The early return
 * below is the proof of that, not an optimisation.
 */

import { getSourceType, getPath, setPath, fieldSpecFor } from './sources/registry.js';
import { makeWarning } from './warnings.js';

export class ScenarioError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScenarioError';
    this.code = code;
  }
}

export const OPS = Object.freeze(['set', 'scale', 'delta', 'enable', 'disable']);

export function makeScenario(partial = {}) {
  return {
    id: partial.id ?? 'base',
    name: partial.name ?? 'Base',
    description: partial.description ?? '',
    basedOn: 'base',
    overrides: partial.overrides ?? [],
    addedSources: partial.addedSources ?? [],
    removedSourceIds: partial.removedSourceIds ?? [],
    assumptionOverrides: partial.assumptionOverrides ?? {},
    presetOrigin: partial.presetOrigin ?? null,
  };
}

const isEmpty = (scenario) =>
  scenario.overrides.length === 0 &&
  scenario.addedSources.length === 0 &&
  scenario.removedSourceIds.length === 0 &&
  Object.keys(scenario.assumptionOverrides).length === 0;

/**
 * Resolve the source list a scenario implies.
 *
 * @returns {{sources: Array, report: Array, warnings: Array}}
 *   `report` records what happened to every override — applied, skipped, shadowed — so the
 *   UI can show it and the attribution narrative can name the cause of each delta.
 */
export function resolveSources(model, scenarioId = 'base') {
  const sources = model.sources ?? [];

  if (scenarioId === 'base') return { sources: structuredClone(sources), report: [], warnings: [] };

  const scenario = (model.scenarios ?? []).find((s) => s.id === scenarioId);
  if (!scenario) {
    throw new ScenarioError('scenario.not_found', `no scenario "${scenarioId}" in this model`);
  }

  // An empty scenario is base. Returning the identical clone guarantees an identical run
  // key rather than merely similar numbers.
  if (isEmpty(scenario)) return { sources: structuredClone(sources), report: [], warnings: [] };

  const report = [];
  const warnings = [];

  const removed = new Set(scenario.removedSourceIds);
  const working = structuredClone(sources.filter((s) => !removed.has(s.id)));
  const byId = new Map(working.map((s) => [s.id, s]));

  // Later overrides win. Record the earlier ones as shadowed rather than applying both,
  // so the report explains why only one took effect.
  const lastByTarget = new Map();
  scenario.overrides.forEach((override, index) => {
    lastByTarget.set(`${override.sourceId}::${override.path ?? override.field}`, index);
  });

  scenario.overrides.forEach((override, index) => {
    const path = override.path ?? override.field;
    const key = `${override.sourceId}::${path}`;

    if (lastByTarget.get(key) !== index) {
      report.push({ overrideId: override.id, status: 'shadowed', path, sourceId: override.sourceId });
      warnings.push(makeWarning('scenario.shadowed_override', { path }, override.sourceId));
      return;
    }

    const source = byId.get(override.sourceId);
    if (!source) {
      report.push({ overrideId: override.id, status: 'dangling', path, sourceId: override.sourceId });
      warnings.push(makeWarning('scenario.dangling_source', { sourceId: override.sourceId }, override.sourceId));
      return;
    }

    const outcome = applyOverride(source, override, path);
    report.push({ overrideId: override.id, sourceId: source.id, path, note: override.note ?? '', ...outcome });
    if (outcome.warning) warnings.push(outcome.warning);
  });

  for (const added of scenario.addedSources) working.push(structuredClone(added));

  return { sources: working, report, warnings };
}

function applyOverride(source, override, path) {
  const def = getSourceType(source.type);

  if (override.op === 'enable' || override.op === 'disable') {
    const before = source.enabled;
    source.enabled = override.op === 'enable';
    return { status: 'applied', before, after: source.enabled };
  }

  // The allowlist. An override may only target a path the source type declares, which is
  // what stops a typo from silently doing nothing.
  if (!def.overridablePaths.includes(path)) {
    return {
      status: 'unknown-path',
      warning: makeWarning('scenario.unknown_path', { path, type: source.type }, source.id),
    };
  }

  const before = getPath(source, path);
  const spec = fieldSpecFor(source.type, path);
  const numeric = spec && (spec.kind === 'money' || spec.kind === 'percent' || spec.kind === 'int');

  let after;
  switch (override.op) {
    case 'set':
      after = override.value;
      break;
    case 'scale':
    case 'delta': {
      if (!numeric) {
        return {
          status: 'type-mismatch',
          warning: makeWarning('scenario.type_mismatch',
            { path, expected: 'a numeric field', got: spec?.kind ?? 'unknown' }, source.id),
        };
      }
      if (typeof before !== 'number') {
        return {
          status: 'type-mismatch',
          warning: makeWarning('scenario.type_mismatch',
            { path, expected: 'a number to adjust', got: typeof before }, source.id),
        };
      }
      after = override.op === 'scale' ? Math.round(before * override.value) : before + override.value;
      break;
    }
    default:
      throw new ScenarioError('scenario.bad_op',
        `unknown override op "${override.op}" (expected one of ${OPS.join(', ')})`);
  }

  if (numeric && typeof after !== 'number') {
    return {
      status: 'type-mismatch',
      warning: makeWarning('scenario.type_mismatch',
        { path, expected: 'a number', got: typeof after }, source.id),
    };
  }

  try {
    setPath(source, path, after);
  } catch (err) {
    return {
      status: 'unknown-path',
      warning: makeWarning('scenario.unknown_path', { path, type: source.type }, source.id),
    };
  }
  return { status: 'applied', before, after };
}

/** True when any override failed to apply — the comparison view marks it incomplete. */
export function isIncomplete(report) {
  return report.some((r) => r.status === 'dangling' || r.status === 'unknown-path' || r.status === 'type-mismatch');
}

/** An override in the shape the resolver expects. */
export function makeOverride(sourceId, path, value, { op = 'set', note = '', id = null } = {}) {
  return { id: id ?? `ovr_${sourceId}_${path.replace(/\./g, '_')}`, sourceId, path, op, value, note };
}
