/**
 * The source-type registry — mechanics only.
 *
 * Deliberately separate from `index.js`, which holds the manifest of type modules.
 * ES module imports are hoisted, so a manifest living in the same file as the registry
 * would run `registerSourceType` before this module's own consts had initialised. Each
 * `sources/*.js` therefore imports from HERE, and `index.js` imports both.
 *
 * A source type declares its fields, its overridable paths and a `compile` function.
 * Everything else — forms, the scenario override editor, validation, charts, attribution —
 * reads those declarations rather than knowing about salaries or rentals specifically.
 * Adding a type is one new file plus one line in the manifest.
 */

export class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

const REGISTRY = new Map();

const REQUIRED_KEYS = ['type', 'label', 'family', 'defaults', 'fields', 'overridablePaths', 'compile'];
const FAMILIES = new Set(['income', 'expense', 'transfer', 'asset', 'liability']);
const FIELD_KINDS = new Set(['money', 'percent', 'date', 'text', 'select', 'bool', 'int']);
const COMPLEXITY = new Set(['simple', 'advanced']);

export function registerSourceType(def) {
  for (const key of REQUIRED_KEYS) {
    if (!(key in def)) {
      throw new RegistryError('registry.missing_key',
        `source type "${def.type ?? '?'}" is missing "${key}"`);
    }
  }
  if (REGISTRY.has(def.type)) {
    throw new RegistryError('registry.duplicate_type', `source type "${def.type}" is already registered`);
  }
  if (!FAMILIES.has(def.family)) {
    throw new RegistryError('registry.bad_family',
      `source type "${def.type}" has family "${def.family}"; expected one of ${[...FAMILIES].join(', ')}`);
  }
  if (def.complexity !== undefined && !COMPLEXITY.has(def.complexity)) {
    throw new RegistryError('registry.bad_complexity',
      `source type "${def.type}" has complexity "${def.complexity}"; expected simple or advanced`);
  }

  for (const field of def.fields) {
    if (!field.path || !field.label) {
      throw new RegistryError('registry.bad_field', `a field on "${def.type}" is missing a path or label`);
    }
    if (!FIELD_KINDS.has(field.kind)) {
      throw new RegistryError('registry.bad_field_kind',
        `field "${field.path}" on "${def.type}" has kind "${field.kind}"`);
    }
  }

  // Every overridable path must be a declared field, or the scenario editor would have no
  // widget to render and no type to validate the override value against.
  const fieldPaths = new Set(def.fields.map((f) => f.path));
  for (const path of def.overridablePaths) {
    if (!fieldPaths.has(path)) {
      throw new RegistryError('registry.override_not_a_field',
        `"${path}" is listed as overridable on "${def.type}" but is not one of its fields`);
    }
  }

  const frozen = Object.freeze({
    check: () => [],
    describe: (source) => source.name,
    // Advanced unless a type says otherwise: a new type should never leak into simple
    // mode just because whoever wrote it forgot to think about the question.
    complexity: 'advanced',
    ...def,
    fields: Object.freeze(def.fields.map((f) => Object.freeze({ ...f }))),
    overridablePaths: Object.freeze([...def.overridablePaths]),
  });

  REGISTRY.set(def.type, frozen);
  return frozen;
}

export function getSourceType(type) {
  const def = REGISTRY.get(type);
  if (!def) {
    throw new RegistryError('registry.unknown_type',
      `no source type "${type}" is registered (known: ${[...REGISTRY.keys()].sort().join(', ')})`);
  }
  return def;
}

export const hasSourceType = (type) => REGISTRY.has(type);
export const listSourceTypeNames = () => [...REGISTRY.keys()].sort();

/** What level a type belongs to. Unknown types are treated as advanced. */
export const complexityOf = (type) => REGISTRY.get(type)?.complexity ?? 'advanced';

/**
 * Registered types, optionally filtered to what a level offers.
 *
 * @param {Object} [options]
 * @param {'simple'|'advanced'} [options.complexity]  omit for everything
 */
export function listSourceTypes({ complexity } = {}) {
  const all = [...REGISTRY.values()].sort((a, b) => a.type.localeCompare(b.type));
  if (complexity !== 'simple') return all;
  return all.filter((def) => def.complexity === 'simple');
}

/** Source types grouped by family, for the "+ Add financial item" picker. */
export function sourceTypesByFamily(options = {}) {
  const out = new Map();
  for (const def of listSourceTypes(options)) {
    const bucket = out.get(def.family);
    if (bucket) bucket.push(def);
    else out.set(def.family, [def]);
  }
  return out;
}

/** Find the FieldSpec behind a dotted path, so an override knows what type it must be. */
export function fieldSpecFor(type, path) {
  return getSourceType(type).fields.find((f) => f.path === path) ?? null;
}

/** Read a dotted path. Returns undefined rather than throwing on a missing branch. */
export function getPath(object, path) {
  let cursor = object;
  for (const key of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * Write a dotted path, refusing to create anything that does not already exist.
 *
 * The refusal is the point. An override targeting a mistyped `details.growthRat` must fail
 * loudly: silently creating the key would produce base numbers while the user believes
 * they modelled a change, which is the worst failure this app can have.
 */
export function setPath(object, path, value) {
  const keys = path.split('.');
  const leaf = keys.pop();

  let cursor = object;
  for (const key of keys) {
    if (cursor === null || typeof cursor !== 'object' || !(key in cursor)) {
      throw new RegistryError('registry.no_such_path', `"${path}" does not exist on this item`);
    }
    cursor = cursor[key];
  }
  if (cursor === null || typeof cursor !== 'object' || !(leaf in cursor)) {
    throw new RegistryError('registry.no_such_path', `"${path}" does not exist on this item`);
  }
  cursor[leaf] = value;
  return object;
}

/** Test-only: drop every registration so a test can register a throwaway type. */
export function resetRegistryForTests() {
  REGISTRY.clear();
}
