/**
 * The single mutable model, its subscribers, and a cache of computed runs.
 *
 * Runs are cached by the model's content hash rather than by an invalidation flag, so a
 * stale run is not possible — if anything about the model changed, the key changes.
 */

import { runProjection } from '../model/engine.js';
import { resolveSources } from '../model/scenarios.js';
import {
  createStore, emptyModel, exportEncrypted, exportJson, importAny, importJson,
  isEncryptedExport,
} from '../model/persistence.js';
import { digest } from '../model/hash.js';
import { COMPARISON_MODES, hasUncertainty } from '../model/realize.js';
import { LEVELS } from '../model/complexity.js';

export function createAppStore({ storage, packs = [] } = {}) {
  const persistence = createStore(storage);
  const listeners = new Set();
  const runCache = new Map();

  let model = emptyModel();
  let taxPacks = packs;
  let usingSample = false;
  let lastError = null;

  const notify = () => {
    for (const listener of listeners) listener(api);
  };

  const cacheKey = (scenarioId, mode) =>
    `${digest({ model, scenarioId, mode })}`;

  const api = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    get model() { return model; },
    get usingSample() { return usingSample; },
    get lastError() { return lastError; },
    get taxPacks() { return taxPacks; },

    setTaxPacks(next) {
      taxPacks = next;
      runCache.clear();
      notify();
    },

    /** Replace the model wholesale — loading, importing, resetting. */
    setModel(next, { sample = false, persist = true } = {}) {
      model = next;
      usingSample = sample;
      runCache.clear();
      if (persist && !sample) void api.save();
      notify();
      return model;
    },

    /**
     * Apply a change. `mutate` receives a deep clone, so a listener can never observe a
     * half-updated model and a thrown error leaves the previous one intact.
     */
    update(mutate, { persist = true } = {}) {
      const draft = structuredClone(model);
      mutate(draft);
      model = draft;
      // Editing sample data makes it yours; stop calling it a sample.
      usingSample = false;
      runCache.clear();
      if (persist) void api.save();
      notify();
      return model;
    },

    /**
     * Switch between simple and advanced.
     *
     * Nothing about the model's contents changes — the projection is identical either way.
     * This only decides how much of it is on screen, which is why switching back is safe.
     */
    setComplexity(level) {
      api.update((draft) => { draft.complexity = level; });
      return level;
    },

    async save() {
      try {
        await persistence.save(model);
        lastError = null;
      } catch (err) {
        lastError = err;
        notify();
      }
    },

    async load() {
      try {
        const saved = await persistence.load();
        lastError = null;
        return saved;
      } catch (err) {
        lastError = err;
        return null;
      }
    },

    async clear() {
      await persistence.clear();
      model = emptyModel();
      usingSample = false;
      runCache.clear();
      notify();
    },

    async lastSavedAt() { return persistence.lastSavedAt(); },
    async backups() { return persistence.backups(); },

    /** A projection, cached by content. */
    run(scenarioId = 'base', mode = 'expected') {
      const key = cacheKey(scenarioId, mode);
      const cached = runCache.get(key);
      if (cached) return cached;

      const result = runProjection({ ...model, taxPacks }, {
        scenarioId,
        mode,
        resolveSources,
      });
      runCache.set(key, result);
      return result;
    },

    /** The won / expected / lost strip, or just one run when nothing is uncertain. */
    runComparison(scenarioId = 'base') {
      const base = api.run(scenarioId, 'expected');
      if (!hasUncertainty(base.events) && base.uncertainSourceIds.length === 0) {
        return new Map([['Projection', base]]);
      }
      return new Map(COMPARISON_MODES.map((mode) => [
        { won: 'If it lands', expected: 'Blended', lost: 'If it does not' }[mode],
        api.run(scenarioId, mode),
      ]));
    },

    /**
     * Switch between simple and advanced.
     *
     * Stored on the MODEL rather than as a UI preference, so it travels with an export and
     * a plan opens the way its author left it.
     */
    setComplexity(level) {
      if (!LEVELS.includes(level)) throw new Error(`unknown complexity level "${level}"`);
      api.update((draft) => { draft.complexity = level; });
    },

    exportJson: () => exportJson(model),
    importJson: (text) => api.setModel(importJson(text)),

    /** The same export, sealed with a password. Async because key derivation is. */
    exportEncrypted: (password) => exportEncrypted(model, password),

    isEncryptedExport,

    /**
     * Import a file of either kind.
     *
     * A failed decryption must leave the current model alone — hence the await before
     * `setModel`, rather than a `.then` that could half-apply.
     */
    async importAny(text, password = null) {
      return api.setModel(await importAny(text, password));
    },
  };

  return api;
}
