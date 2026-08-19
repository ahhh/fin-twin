/**
 * Password-protected exports.
 *
 * The properties worth asserting are the ones a reviewer would want proof of: that the
 * ciphertext really is unreadable, that the same plaintext never encrypts to the same
 * bytes twice, that a wrong password fails rather than producing plausible nonsense, and
 * that tampering with the file — including with the KDF parameters that are stored in the
 * clear — is detected.
 *
 * Iteration counts here are dialled down to the minimum the format accepts; 600k rounds
 * per assertion would make the suite crawl for no extra coverage.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  CryptoError, ENVELOPE_VERSION, KDF_ITERATIONS, decryptText, encryptText, isEnvelope,
} from '../model/crypto.js';
import {
  exportEncrypted, exportFilename, exportJson, importAny, importEncrypted, importJson,
  isEncryptedExport, migrate,
} from '../model/persistence.js';
import { registerBuiltInCloseRules } from '../model/close-rules.js';
import { sliceModel } from './helpers/models.js';

before(() => registerBuiltInCloseRules());

const FAST = { iterations: 100_000 };
const PASSWORD = 'correct horse battery staple';

async function throwsCodeAsync(fn, code, message) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `${message ?? ''} (got ${err.code}: ${err.message})`);
    return true;
  });
}

/* ---- round trip ---- */

test('encrypt then decrypt returns the original text exactly', async () => {
  const text = 'the quick brown fox — café, 日本,   and a "quote"';
  const envelope = await encryptText(text, PASSWORD, FAST);
  assert.equal(await decryptText(envelope, PASSWORD), text);
});

test('the envelope is plain JSON: it survives a stringify/parse trip', async () => {
  const envelope = await encryptText('{"a":1}', PASSWORD, FAST);
  const reparsed = JSON.parse(JSON.stringify(envelope));
  assert.equal(await decryptText(reparsed, PASSWORD), '{"a":1}');
});

test('the envelope stores only non-secret material', async () => {
  const envelope = await encryptText('secret', PASSWORD, FAST);
  assert.deepEqual(
    Object.keys(envelope).sort(),
    ['cipher', 'ciphertext', 'fdtEncrypted', 'iv', 'kdf'],
  );
  assert.equal(envelope.fdtEncrypted, ENVELOPE_VERSION);
  assert.equal(envelope.cipher, 'AES-GCM');
  assert.equal(envelope.kdf.name, 'PBKDF2');
  assert.equal(envelope.kdf.hash, 'SHA-256');
  assert.equal(isEnvelope(envelope), true);
});

test('the ciphertext does not contain the plaintext', async () => {
  const secret = 'MY-SALARY-IS-123456';
  const envelope = await encryptText(secret, PASSWORD, FAST);
  const serialised = JSON.stringify(envelope);
  assert.ok(!serialised.includes(secret), 'the plaintext appears verbatim in the envelope');

  // The base64 of the plaintext must not appear either — that would be encoding, not
  // encryption, and it is exactly what a broken XOR-with-a-constant would produce.
  assert.ok(!serialised.includes(btoa(secret)), 'the plaintext is merely encoded');
});

/* ---- the properties that make it not a toy ---- */

test('the same text and password encrypt differently every time', async () => {
  const a = await encryptText('same', PASSWORD, FAST);
  const b = await encryptText('same', PASSWORD, FAST);
  assert.notEqual(a.ciphertext, b.ciphertext, 'a repeated ciphertext leaks that two files match');
  assert.notEqual(a.iv, b.iv, 'a reused IV breaks AES-GCM completely');
  assert.notEqual(a.kdf.salt, b.kdf.salt, 'a reused salt lets one cracking run open both files');
});

test('a keystream is never reused across two plaintexts under one password', async () => {
  // The classic hand-rolled-XOR bug: keystream = hash(password), so XORing two ciphertexts
  // cancels it and leaks plaintext ^ plaintext. Distinct salts and IVs are what prevent it.
  const a = await encryptText('A'.repeat(64), PASSWORD, FAST);
  const b = await encryptText('B'.repeat(64), PASSWORD, FAST);
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const left = bytes(a.ciphertext);
  const right = bytes(b.ciphertext);
  const xor = [...left].map((byte, i) => byte ^ right[i]);

  // Under a reused keystream every byte of this would be 'A' ^ 'B' = 0x03.
  assert.ok(xor.some((byte) => byte !== 0x03), 'the two ciphertexts share a keystream');
});

test('a wrong password is rejected rather than producing garbage', async () => {
  const envelope = await encryptText('the model', PASSWORD, FAST);
  await throwsCodeAsync(() => decryptText(envelope, 'wrong password'), 'crypto.wrong_password');
  await throwsCodeAsync(() => decryptText(envelope, `${PASSWORD} `), 'crypto.wrong_password',
    'a trailing space is a different password');
});

test('an empty password is refused outright, not treated as a key', async () => {
  await throwsCodeAsync(() => encryptText('x', ''), 'crypto.no_password');
  await throwsCodeAsync(() => encryptText('x', null), 'crypto.no_password');
  await throwsCodeAsync(() => encryptText('x', undefined), 'crypto.no_password');
});

test('a password is compared after Unicode normalisation, so the same keystrokes open the file', async () => {
  // "cafe" with an acute accent, composed (U+00E9) and decomposed (e + U+0301). The two
  // look identical on screen and are produced by different keyboards; without NFC one
  // machine could not open the other's file.
  const composed = 'caf\u00e9-secret';        // e-acute as one code point
  const decomposed = 'cafe\u0301-secret';    // e + combining acute
  assert.notEqual(composed, decomposed, 'the two spellings really are different strings');

  const envelope = await encryptText('model', composed, FAST);
  assert.equal(await decryptText(envelope, decomposed), 'model');
});

test('tampering with the ciphertext is detected', async () => {
  const envelope = await encryptText('the model', PASSWORD, FAST);
  const bytes = Uint8Array.from(atob(envelope.ciphertext), (c) => c.charCodeAt(0));
  bytes[0] ^= 0x01;
  const tampered = { ...envelope, ciphertext: btoa(String.fromCharCode(...bytes)) };
  await throwsCodeAsync(() => decryptText(tampered, PASSWORD), 'crypto.wrong_password');
});

test('tampering with the clear-text header is detected too', async () => {
  const envelope = await encryptText('the model', PASSWORD, FAST);

  // The KDF parameters are stored unencrypted because they are needed to derive the key.
  // They are authenticated, so downgrading the work factor cannot be done quietly.
  await throwsCodeAsync(
    () => decryptText({ ...envelope, kdf: { ...envelope.kdf, iterations: 150_000 } }, PASSWORD),
    'crypto.wrong_password',
    'the iteration count is not covered by the authentication tag',
  );
});

/* ---- refusing files before doing work on them ---- */

test('an implausible iteration count is refused before any hashing happens', async () => {
  const envelope = await encryptText('x', PASSWORD, FAST);
  for (const iterations of [1, 10, 99_999, 50_000_000, 1.5, '600000', null]) {
    await throwsCodeAsync(
      () => decryptText({ ...envelope, kdf: { ...envelope.kdf, iterations } }, PASSWORD),
      'crypto.bad_envelope',
      `iterations=${iterations} should be refused`,
    );
  }
});

test('an unsupported cipher or KDF is named rather than guessed at', async () => {
  const envelope = await encryptText('x', PASSWORD, FAST);
  await throwsCodeAsync(() => decryptText({ ...envelope, cipher: 'AES-CBC' }, PASSWORD),
    'crypto.bad_envelope');
  await throwsCodeAsync(
    () => decryptText({ ...envelope, kdf: { ...envelope.kdf, hash: 'SHA-1' } }, PASSWORD),
    'crypto.bad_envelope');
  await throwsCodeAsync(() => decryptText({ ...envelope, kdf: null }, PASSWORD),
    'crypto.bad_envelope');
});

test('a file from a newer format says so instead of failing obscurely', async () => {
  const envelope = await encryptText('x', PASSWORD, FAST);
  await throwsCodeAsync(
    () => decryptText({ ...envelope, fdtEncrypted: ENVELOPE_VERSION + 1 }, PASSWORD),
    'crypto.from_the_future');
});

test('corrupt base64 is a bad envelope, not a crash', async () => {
  const envelope = await encryptText('x', PASSWORD, FAST);
  await throwsCodeAsync(() => decryptText({ ...envelope, iv: 'not base64!!' }, PASSWORD),
    'crypto.bad_envelope');
  await throwsCodeAsync(() => decryptText({ ...envelope, ciphertext: 42 }, PASSWORD),
    'crypto.bad_envelope');
  await throwsCodeAsync(() => decryptText('nonsense', PASSWORD), 'crypto.bad_envelope');
  assert.equal(isEnvelope([1, 2]), false);
  assert.equal(isEnvelope(null), false);
});

test('the default work factor is not quietly weak', () => {
  assert.ok(KDF_ITERATIONS >= 600_000, 'PBKDF2-SHA-256 below 600k rounds is below the 2023 floor');
});

/* ---- the export/import path ---- */

test('an encrypted export round-trips to the same model as a plain one', async () => {
  const model = migrate(sliceModel());
  const encrypted = await exportEncrypted(model, PASSWORD);
  const restored = await importEncrypted(encrypted, PASSWORD);

  assert.deepEqual(restored, importJson(exportJson(model)),
    'encrypting must not change what comes back');
});

test('an encrypted export is still a JSON file, and says what it is', async () => {
  const text = await exportEncrypted(migrate(sliceModel()), PASSWORD);
  const parsed = JSON.parse(text);

  assert.equal(isEncryptedExport(text), true);
  assert.equal(isEncryptedExport(exportJson(sliceModel())), false);
  assert.equal(isEncryptedExport('not json at all'), false);
  assert.match(parsed._warning, /password/i);
  assert.ok(parsed.exportedAt, 'an encrypted file still records when it was written');
});

test('no financial figure from the model survives into the encrypted file', async () => {
  const model = migrate(sliceModel());
  const text = await exportEncrypted(model, PASSWORD);

  for (const source of model.sources) {
    if (source.name) assert.ok(!text.includes(source.name), `"${source.name}" leaked in clear`);
  }
  assert.ok(!text.includes('"sources"'), 'the model structure is visible in the file');
});

test('importing an encrypted file without a password explains what is needed', () => {
  // The sync path is what an old caller (or a drag-and-drop) hits first; it must not say
  // "that file does not contain a model".
  const envelope = JSON.stringify({ fdtEncrypted: 1, cipher: 'AES-GCM' });
  assert.throws(() => importJson(envelope), (err) => {
    assert.equal(err.code, 'persist.encrypted');
    assert.match(err.message, /password/i);
    return true;
  });
});

test('importAny handles both kinds without being told which it has', async () => {
  const model = migrate(sliceModel());

  const plain = await importAny(exportJson(model));
  assert.deepEqual(plain.sources, model.sources);

  const sealed = await importAny(await exportEncrypted(model, PASSWORD), PASSWORD);
  assert.deepEqual(sealed.sources, model.sources);

  const sealedText = await exportEncrypted(model, PASSWORD);
  await throwsCodeAsync(() => importAny(sealedText, 'nope'), 'crypto.wrong_password');
});

test('the encrypted filename is distinguishable from a plain export', () => {
  assert.equal(exportFilename('2026-08-19'), 'financial-twin-2026-08-19.json');
  assert.equal(
    exportFilename('2026-08-19', { encrypted: true }),
    'financial-twin-2026-08-19.encrypted.json',
  );
});

test('CryptoError carries a code, like every other error in the model', async () => {
  const err = await encryptText('x', '').catch((e) => e);
  assert.ok(err instanceof CryptoError);
  assert.equal(err.name, 'CryptoError');
  assert.equal(typeof err.code, 'string');
});
