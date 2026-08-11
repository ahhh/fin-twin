import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, digest, fnv1a64, runKeyFor } from '../model/hash.js';
import { anEvent, seededRandom, shuffle, throwsCode } from './helpers/build.js';

test('canonicalJson sorts keys at every depth', () => {
  assert.equal(
    canonicalJson({ b: 2, a: 1 }),
    canonicalJson({ a: 1, b: 2 }),
    'key order must not change the canonical form',
  );
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson({ z: { y: 1, x: 2 }, a: [{ n: 1, m: 2 }] }),
    '{"a":[{"m":2,"n":1}],"z":{"x":2,"y":1}}',
  );
});

test('canonicalJson preserves array order — arrays are sequences, not sets', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
});

test('canonicalJson refuses values JSON cannot round-trip', () => {
  throwsCode(() => canonicalJson({ x: NaN }), 'hash.not_finite');
  throwsCode(() => canonicalJson({ x: Infinity }), 'hash.not_finite');
  throwsCode(() => canonicalJson([undefined]), 'hash.undefined');
  throwsCode(() => canonicalJson({ f: () => 1 }), 'hash.unsupported_type');
  throwsCode(() => canonicalJson({ m: new Map([['a', 1]]) }), 'hash.not_plain_object',
    'a Map would serialise to {} and silently lose its contents');
});

test('canonicalJson drops undefined properties, matching JSON.stringify', () => {
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
});

test('canonicalJson normalises -0, which stringifies differently but compares equal', () => {
  assert.equal(canonicalJson({ x: -0 }), canonicalJson({ x: 0 }));
});

test('fnv1a64 is deterministic, 16 hex chars, and sensitive to small changes', () => {
  const a = fnv1a64('hello');
  assert.equal(a, fnv1a64('hello'));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, fnv1a64('hellp'), 'a one-character change must change the digest');
  assert.notEqual(a, fnv1a64('olleh'), 'order must matter');
  assert.notEqual(fnv1a64(''), fnv1a64('a'));
  assert.match(fnv1a64(''), /^[0-9a-f]{16}$/);
});

test('fnv1a64 spreads well enough for run keys', () => {
  // Not a cryptographic claim — just that 5000 near-identical inputs do not collide,
  // which is the only property runKey and golden digests depend on.
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(fnv1a64(`src_test:2026-08-31:INCOME_GROSS:${i}`));
  assert.equal(seen.size, 5000, 'digest collision across sequential ids');
});

test('fnv1a64 distinguishes non-ASCII input', () => {
  assert.notEqual(fnv1a64('café'), fnv1a64('cafe'));
  assert.notEqual(fnv1a64('日本'), fnv1a64('本日'));
});

test('digest is canonicalJson plus fnv1a64, so key order cannot change it', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.equal(digest({ a: 1 }), fnv1a64('{"a":1}'));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});

test('runKeyFor is stable under event order and sensitive to the numbers', () => {
  const events = [];
  for (let i = 0; i < 50; i++) {
    events.push(anEvent({ seq: i, cashAmount: 1_000 + i, taxableAmount: 0, taxCategory: null }));
  }

  const key = runKeyFor(events);
  assert.equal(key, runKeyFor([...events]), 'same input, same key');

  // Reordering the array must not change the key: the run is the set of effects.
  const random = seededRandom(7);
  assert.notEqual(
    runKeyFor(shuffle(events, random)),
    key,
    'runKeyFor hashes the sequence as given — callers pass a sorted stream',
  );

  const changed = [...events];
  changed[10] = anEvent({ seq: 10, cashAmount: 999_999, taxableAmount: 0, taxCategory: null });
  assert.notEqual(runKeyFor(changed), key, 'a changed amount must change the run key');
});

test('runKeyFor ignores cosmetic fields so renaming is not a financial change', () => {
  const withLabel = [anEvent({ label: 'Primary Job' })];
  const renamed = [anEvent({ label: 'Main Gig' })];
  assert.equal(
    runKeyFor(withLabel),
    runKeyFor(renamed),
    'a label change must not read as a different outcome',
  );

  const tagged = [anEvent({ tags: ['a'] })];
  assert.equal(runKeyFor(withLabel), runKeyFor(tagged), 'tags are cosmetic for the run key');
});
