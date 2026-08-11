import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SCHEMA_VERSION, createStore, emptyModel, exportFilename, exportJson, importJson,
  memoryStorage, migrate,
} from '../model/persistence.js';
import { runProjection } from '../model/engine.js';
import { registerBuiltInCloseRules } from '../model/close-rules.js';
import { resolveSources } from '../model/scenarios.js';
import { REPO_ROOT } from './helpers/files.js';
import { PACKS } from './helpers/packs.js';
import { sliceModel } from './helpers/models.js';

before(() => registerBuiltInCloseRules());

const templates = JSON.parse(await readFile(join(REPO_ROOT, 'data/templates.json'), 'utf8')).templates;

/* ---- round trip ---- */

test('export then import returns exactly the same model', () => {
  const model = sliceModel();
  const restored = importJson(exportJson(model));

  // The export adds provenance; those fields must not come back as model data.
  assert.equal(restored.exportedAt, undefined);
  assert.equal(restored._warning, undefined);

  for (const key of ['sources', 'household', 'openingBalances', 'horizon']) {
    assert.deepEqual(restored[key], model[key], `${key} did not survive the round trip`);
  }
});

test('a round-tripped model produces an identical run', () => {
  // Baseline is a MIGRATED model: `migrate` fills in fields added since the model was
  // written, which is the point of it. The property that has to hold is that a model which
  // has already been through the app round-trips with nothing changed.
  const model = migrate(sliceModel());

  const before_ = runProjection({ ...model, taxPacks: PACKS }, { resolveSources });
  const after = runProjection(
    { ...importJson(exportJson(model)), taxPacks: PACKS }, { resolveSources },
  );

  assert.equal(after.runKey, before_.runKey, 'the numbers must be bit-identical after a round trip');
});

test('the export carries a warning about what is in it', () => {
  const text = exportJson(emptyModel());
  assert.match(text, /personal financial information/i);
  assert.match(exportFilename('2026-08-11'), /^financial-twin-2026-08-11\.json$/);
});

test('importing rubbish fails with a readable message', () => {
  assert.throws(() => importJson('not json at all'), (err) => err.code === 'persist.bad_json');
  assert.throws(() => importJson('"a string"'), (err) => err.code === 'persist.not_a_model');
});

/* ---- migration ---- */

test('an old model without newer fields still loads', () => {
  const ancient = {
    schemaVersion: 0,
    sources: [],
    household: { filingStatus: 'single', people: [] },
    horizon: { startDate: '2026-01-01', years: 5 },
  };
  const migrated = migrate(ancient);

  assert.equal(migrated.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(migrated.liquidAccounts, ['cash', 'savings'], 'a field added later gets a default');
  assert.deepEqual(migrated.scenarios, []);
  assert.equal(ancient.liquidAccounts, undefined, 'the input is not mutated');
});

test('a model from a newer build is refused rather than half-read', () => {
  assert.throws(
    () => migrate({ schemaVersion: SCHEMA_VERSION + 1, sources: [] }),
    (err) => err.code === 'persist.from_the_future',
  );
});

/* ---- storage ---- */

test('saving then loading returns the model', async () => {
  const store = createStore(memoryStorage());
  assert.equal(await store.load(), null, 'nothing saved yet');

  await store.save(sliceModel());
  const loaded = await store.load();
  assert.equal(loaded.sources.length, 4);
  assert.ok(await store.lastSavedAt());
});

test('each save rotates the previous version into a backup', async () => {
  const store = createStore(memoryStorage());

  await store.save({ ...emptyModel(), sources: [{ id: 'one' }] });
  await store.save({ ...emptyModel(), sources: [{ id: 'one' }, { id: 'two' }] });
  await store.save({ ...emptyModel(), sources: [{ id: 'one' }, { id: 'two' }, { id: 'three' }] });

  const backups = await store.backups();
  assert.equal(backups.length, 2, 'earlier versions are recoverable');
  assert.equal(backups[0].sources, 2, 'newest backup first');

  const restored = await store.restore(backups[0].key);
  assert.equal(restored.sources.length, 2);
});

test('a full quota is reported, not swallowed', async () => {
  const failing = {
    getItem: () => null,
    setItem: () => { const err = new Error('full'); err.name = 'QuotaExceededError'; throw err; },
    removeItem: () => {},
  };
  await assert.rejects(
    () => createStore(failing).save(emptyModel()),
    (err) => err.code === 'persist.quota' && /export/i.test(err.message),
  );
});

test('corrupt saved data is reported rather than crashing the app', async () => {
  const store = createStore(memoryStorage({ 'fdt.model.v1': '{ broken' }));
  await assert.rejects(() => store.load(), (err) => err.code === 'persist.corrupt');
});

test('clearing removes every trace, including backups', async () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  await store.save(emptyModel());
  await store.save(emptyModel());
  await store.clear();

  assert.equal(await store.load(), null);
  assert.deepEqual(await store.backups(), []);
});

/* ---- the shipped templates ---- */

test('every shipped template loads, migrates and runs without error', () => {
  assert.ok(templates.length >= 3);

  for (const template of templates) {
    const model = migrate(template.model);
    const run = runProjection({ ...model, taxPacks: PACKS }, { resolveSources });

    assert.ok(run.months.length > 0, `${template.id} produced no months`);

    const errors = run.warnings.filter((w) => w.severity === 'error');
    assert.deepEqual(
      errors.map((w) => w.code), [],
      `${template.id} has integrity errors: ${errors.map((w) => w.message).join('; ')}`,
    );
  }
});

test('exactly one template is marked as the first-run sample', () => {
  const samples = templates.filter((t) => t.sample);
  assert.equal(samples.length, 1, 'a first visit must have one obvious starting point');
  assert.ok(samples[0].blurb, 'the sample needs a one-line explanation');
});

test('the first-run sample is deliberately the simplest one', () => {
  // A first screen full of contract income, sinking funds and tax reserves teaches
  // nothing. The sample is a salary and some bills; the showcase is one click away.
  const sample = templates.find((t) => t.sample);
  const model = migrate(sample.model);
  const run = runProjection({ ...model, taxPacks: PACKS }, { resolveSources });

  assert.equal(model.complexity, 'simple');
  assert.equal(run.uncertainSourceIds.length, 0, 'nothing uncertain to explain on day one');
  assert.ok(run.months.length > 0);
  assert.ok(run.metrics.liquidCash.value !== 0, 'but it still produces real numbers');
});

test('the richer template is still there for anyone who wants it', () => {
  const showcase = templates.find((t) => t.id === 'freelancer-plus-salary');
  assert.ok(showcase, 'the freelancer template should still ship');

  const run = runProjection({ ...migrate(showcase.model), taxPacks: PACKS }, { resolveSources });
  assert.ok(run.uncertainSourceIds.length > 0, 'it demonstrates uncertain income');
  assert.ok(run.events.some((e) => e.tags.includes('sinking-fund')), 'and a sinking fund');
});
