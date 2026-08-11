/**
 * Saving, loading, importing and exporting the model.
 *
 * The storage interface is ASYNC even though localStorage is synchronous. That is
 * deliberate: when this needs to become IndexedDB — for Monte Carlo result caching, or
 * simply for more room — the swap is invisible to every caller.
 *
 * localStorage is the only copy of a household's financial life, and one cleared-site-data
 * click destroys it. Hence three rotating autosave slots, an explicit quota error rather
 * than a silent failure, and the export nudge the UI shows.
 */

import { todayISO } from './dates.js';
import { DEFAULT_LEVEL } from './complexity.js';

/** Types that only advanced mode can fully show. Kept local to avoid importing the
 *  registry here — persistence must load even if no source module has been imported. */
const ADVANCED_TYPES = new Set([
  'contract', 'transfer', 'loan', 'asset',
  'royalty', 'fixed_contract', 'windfall', 'investment_income',
]);

const hasAdvancedContent = (model) =>
  (model.sources ?? []).some((s) => ADVANCED_TYPES.has(s.type)) ||
  (model.scenarios ?? []).length > 0;

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '0.1.0';

const PRIMARY_KEY = 'fdt.model.v1';
const BACKUP_KEYS = ['fdt.model.backup.1', 'fdt.model.backup.2', 'fdt.model.backup.3'];
const META_KEY = 'fdt.meta.v1';

export class PersistenceError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
    this.cause = cause;
  }
}

/* -------------------------------------------------------------------------- */
/* The empty model                                                             */
/* -------------------------------------------------------------------------- */

export function emptyModel(startDate = todayISO()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: APP_VERSION,
    currency: 'USD',
    // Simple by default. Everything this app is best at — irregular income, tax reality,
    // scenarios — is also what makes a first screen unreadable, so it is opt-in.
    complexity: DEFAULT_LEVEL,
    household: {
      filingStatus: 'single',
      people: [{ id: 'p1', name: 'You', birthYear: null }],
      state: '',
      dependents: 0,
    },
    horizon: { startDate, years: 5 },
    openingBalances: { cash: 0 },
    liquidAccounts: ['cash', 'savings'],
    emergencyTargetMonths: 3,
    taxReserveRate: 0.3,
    useProjectedTaxRate: true,
    assumptions: {},
    sources: [],
    scenarios: [],
    goals: [],
    priorYear: null,
    createdAt: todayISO(),
    updatedAt: todayISO(),
  };
}

/* -------------------------------------------------------------------------- */
/* Migration                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Migrations, applied in order. A model exported by an older build must always load.
 *
 * Each entry takes a model at version N and returns one at N+1. Never mutate the input:
 * a failed migration must leave the user's data untouched so they can export it and ask
 * for help.
 */
const MIGRATIONS = {
  // 0 -> 1: the first released shape. Fills in fields added after early drafts.
  1: (model) => ({
    ...model,
    schemaVersion: 1,
    liquidAccounts: model.liquidAccounts ?? ['cash', 'savings'],
    emergencyTargetMonths: model.emergencyTargetMonths ?? 3,
    scenarios: model.scenarios ?? [],
    goals: model.goals ?? [],
    assumptions: model.assumptions ?? {},
    // A model saved before this setting existed was built with everything on screen, so
    // it opens in advanced mode. Demoting someone's plan to a simpler view without asking
    // would hide parts of it they had already built.
    complexity: model.complexity ?? (hasAdvancedContent(model) ? 'advanced' : DEFAULT_LEVEL),
  }),
};

export function migrate(model) {
  if (!model || typeof model !== 'object') {
    throw new PersistenceError('persist.not_a_model', 'that file does not contain a model');
  }

  let current = structuredClone(model);
  let version = current.schemaVersion ?? 0;

  if (version > SCHEMA_VERSION) {
    throw new PersistenceError(
      'persist.from_the_future',
      `this file was saved by a newer version of the app (schema ${version}; this build ` +
        `understands ${SCHEMA_VERSION}). Update the app, or export from the newer one.`,
    );
  }

  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version + 1];
    if (!step) {
      throw new PersistenceError('persist.no_migration',
        `no migration from schema ${version} to ${version + 1}`);
    }
    current = step(current);
    version += 1;
  }

  return { ...emptyModel(current.horizon?.startDate), ...current, schemaVersion: SCHEMA_VERSION };
}

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

/** In-memory fallback, so the app still works with storage disabled (and in tests). */
export function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('fdt.probe', '1');
      localStorage.removeItem('fdt.probe');
      return localStorage;
    }
  } catch {
    // Private browsing, or storage blocked. Fall through.
  }
  return memoryStorage();
}

export function createStore(storage = defaultStorage()) {
  return {
    /** Load the saved model, or null if there is none. */
    async load() {
      const raw = storage.getItem(PRIMARY_KEY);
      if (raw === null) return null;
      try {
        return migrate(JSON.parse(raw));
      } catch (err) {
        if (err instanceof PersistenceError) throw err;
        throw new PersistenceError('persist.corrupt',
          'the saved model could not be read. A backup may still be intact.', err);
      }
    },

    /** Save, rotating the previous version into a backup slot first. */
    async save(model) {
      const payload = JSON.stringify({ ...model, updatedAt: todayISO() });
      try {
        rotateBackups(storage);
        storage.setItem(PRIMARY_KEY, payload);
        storage.setItem(META_KEY, JSON.stringify({ savedAt: todayISO() }));
      } catch (err) {
        if (err?.name === 'QuotaExceededError' || err?.code === 22) {
          throw new PersistenceError('persist.quota',
            'this browser is out of storage space, so the model was NOT saved. ' +
            'Export it to a file before making more changes.', err);
        }
        throw new PersistenceError('persist.save_failed', 'the model could not be saved.', err);
      }
      return model;
    },

    /** Every recoverable copy, newest first, for the "restore a backup" path. */
    async backups() {
      const out = [];
      for (const key of BACKUP_KEYS) {
        const raw = storage.getItem(key);
        if (raw === null) continue;
        try {
          const parsed = JSON.parse(raw);
          out.push({ key, updatedAt: parsed.updatedAt ?? null, sources: parsed.sources?.length ?? 0 });
        } catch {
          // A corrupt backup is not worth failing over; the others may be fine.
        }
      }
      return out;
    },

    async restore(key) {
      const raw = storage.getItem(key);
      if (raw === null) throw new PersistenceError('persist.no_backup', `no backup at ${key}`);
      return migrate(JSON.parse(raw));
    },

    /** Delete everything this app has stored. */
    async clear() {
      for (const key of [PRIMARY_KEY, META_KEY, ...BACKUP_KEYS]) storage.removeItem(key);
    },

    async lastSavedAt() {
      const raw = storage.getItem(META_KEY);
      if (raw === null) return null;
      try {
        return JSON.parse(raw).savedAt ?? null;
      } catch {
        return null;
      }
    },
  };
}

function rotateBackups(storage) {
  const current = storage.getItem(PRIMARY_KEY);
  if (current === null) return;
  for (let i = BACKUP_KEYS.length - 1; i > 0; i--) {
    const previous = storage.getItem(BACKUP_KEYS[i - 1]);
    if (previous !== null) storage.setItem(BACKUP_KEYS[i], previous);
  }
  storage.setItem(BACKUP_KEYS[0], current);
}

/* -------------------------------------------------------------------------- */
/* Import / export                                                             */
/* -------------------------------------------------------------------------- */

export function exportJson(model) {
  return JSON.stringify(
    {
      ...model,
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: todayISO(),
      _warning:
        'This file contains personal financial information. Store it somewhere you would ' +
        'be comfortable storing a bank statement.',
    },
    null,
    2,
  );
}

export function importJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PersistenceError('persist.bad_json', 'that file is not valid JSON.', err);
  }

  // Valid JSON is not necessarily a model. Spreading a string or an array would produce an
  // object with numeric keys and get much further than it should.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PersistenceError('persist.not_a_model', 'that file does not contain a model');
  }

  // Round-tripping must not resurrect export-only fields as model data.
  const { exportedAt, _warning, ...model } = parsed;
  return migrate(model);
}

/** A filename that sorts chronologically and says what it is. */
export function exportFilename(date = todayISO()) {
  return `financial-twin-${date}.json`;
}

/**
 * Load the starter templates.
 *
 * Lives here rather than in `app.js` so that fetching stays confined to the two modules
 * the no-network guard allows — the CSP restricts the app to its own origin, and this
 * keeps the code shaped that way too.
 */
export async function loadTemplates(url = 'data/templates.json') {
  const response = await fetch(url);
  if (!response.ok) {
    throw new PersistenceError('persist.no_templates', `could not load templates (${response.status})`);
  }
  const { templates } = await response.json();
  return templates.map((template) => ({
    ...template,
    model: migrate(template.model),
  }));
}

/** The template marked as the first-run sample. */
export async function loadSampleTemplate(url = 'data/templates.json') {
  const templates = await loadTemplates(url);
  return templates.find((t) => t.sample) ?? templates[0] ?? null;
}
