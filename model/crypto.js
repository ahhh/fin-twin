/**
 * Password-based encryption for exported models.
 *
 * The shape asked for is "hash the password, then XOR the content with it". That is the
 * right instinct and this is exactly what runs — but the two halves are the standard
 * primitives rather than hand-rolled ones, because both halves are easy to get wrong in a
 * way that looks fine:
 *
 *   - The hash is **PBKDF2-HMAC-SHA-256** over a random 16-byte salt, not a bare digest.
 *     A bare SHA-256 of a password is guessable at billions of tries a second on a GPU;
 *     the iteration count is the whole defence, and the salt is what stops one rainbow
 *     table opening every file ever exported by this app.
 *   - The XOR is **AES-256-GCM**, which is counter mode: AES generates a keystream and the
 *     content is XORed with it, one time, under a random 12-byte IV. XORing against a
 *     repeating hash instead would be a Vigenère cipher — recoverable from the plaintext
 *     structure alone, and JSON is nothing but known plaintext (`{"schemaVersion":`).
 *     GCM also carries an authentication tag, so a corrupted or edited file fails loudly
 *     instead of decrypting into plausible-looking nonsense numbers.
 *
 * The header — cipher, KDF parameters, IV — is authenticated as GCM additional data, so
 * nobody can quietly rewrite `iterations: 600000` down to `1` in a file and hand it back.
 *
 * Everything here is WebCrypto, present in the browser and in Node's test runner alike. No
 * dependency is added, and no key material is ever written to storage — only the salt, the
 * IV and the ciphertext, none of which are secret.
 */

import { canonicalJson } from './hash.js';

export class CryptoError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
    this.cause = cause;
  }
}

/** The envelope format. Bumped only if the wire shape changes incompatibly. */
export const ENVELOPE_VERSION = 1;

/**
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA-256. Costs roughly a third of a second on a
 * current laptop and rather more on a phone — acceptable once per export, and the only
 * thing standing between a weak password and an offline attacker with the file.
 */
export const KDF_ITERATIONS = 600_000;

/** Bounds for an iteration count read out of a *file*, before any work is done on it. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

const SALT_BYTES = 16;
const IV_BYTES = 12; // 96 bits: the size GCM is specified for.
const KEY_BITS = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* -------------------------------------------------------------------------- */
/* Platform                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * WebCrypto, or a clear explanation of its absence.
 *
 * `crypto.subtle` is only exposed in secure contexts, so a page served over plain http://
 * from anything other than localhost has no encryption available. Better to say that than
 * to fall back to something weaker under the same name.
 */
function subtle() {
  const api = globalThis.crypto?.subtle;
  if (!api) {
    throw new CryptoError(
      'crypto.unavailable',
      'encryption is unavailable here. It needs a secure context — open the app over ' +
        'https:// or from localhost.',
    );
  }
  return api;
}

function randomBytes(length) {
  const api = globalThis.crypto;
  if (!api?.getRandomValues) {
    throw new CryptoError('crypto.unavailable', 'no secure random source is available here.');
  }
  return api.getRandomValues(new Uint8Array(length));
}

/* -------------------------------------------------------------------------- */
/* Base64                                                                      */
/* -------------------------------------------------------------------------- */

/** Chunked, because spreading a megabyte-long array into `fromCharCode` overflows the stack. */
function toBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value, field) {
  if (typeof value !== 'string') {
    throw new CryptoError('crypto.bad_envelope', `the encrypted file's "${field}" is missing`);
  }
  let binary;
  try {
    binary = atob(value);
  } catch (err) {
    throw new CryptoError('crypto.bad_envelope',
      `the encrypted file's "${field}" is not valid base64`, err);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Key derivation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Normalise before encoding.
 *
 * "café" typed on a Mac and on Windows can be two different byte strings — same letters,
 * different composition. Without NFC the same password fails to open the same file on a
 * different machine, which reads as data loss.
 */
function passwordBytes(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new CryptoError('crypto.no_password', 'a password is required');
  }
  return encoder.encode(password.normalize('NFC'));
}

async function deriveKey(password, salt, iterations) {
  const material = await subtle().importKey(
    'raw', passwordBytes(password), 'PBKDF2', false, ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_BITS },
    false, // non-extractable: the key cannot be read back out of the object
    ['encrypt', 'decrypt'],
  );
}

/**
 * The bytes GCM authenticates alongside the ciphertext.
 *
 * Canonical JSON so the same header always produces the same bytes regardless of key
 * order — otherwise a re-serialised envelope would fail to decrypt for no visible reason.
 */
function additionalData(header) {
  return encoder.encode(canonicalJson(header));
}

const headerOf = (envelope) => ({
  fdtEncrypted: envelope.fdtEncrypted,
  cipher: envelope.cipher,
  iv: envelope.iv,
  kdf: envelope.kdf,
});

/* -------------------------------------------------------------------------- */
/* Encrypt / decrypt                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Encrypt text into a self-describing envelope.
 *
 * The envelope is a plain object of base64 strings so it serialises as ordinary JSON: an
 * encrypted export is still a `.json` file that a file picker will accept and a human can
 * open to see what it is, rather than an opaque blob.
 */
export async function encryptText(plaintext, password, { iterations = KDF_ITERATIONS } = {}) {
  if (typeof plaintext !== 'string') {
    throw new CryptoError('crypto.not_text', 'only text can be encrypted');
  }

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);

  const envelope = {
    fdtEncrypted: ENVELOPE_VERSION,
    cipher: 'AES-GCM',
    iv: toBase64(iv),
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: toBase64(salt),
    },
  };

  const key = await deriveKey(password, salt, iterations);
  const ciphertext = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(headerOf(envelope)) },
    key,
    encoder.encode(plaintext),
  );

  return { ...envelope, ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/** True if this looks like one of our envelopes. Cheap, and does no crypto. */
export function isEnvelope(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.fdtEncrypted === 'number';
}

/** Validate the envelope's declared parameters before spending 600k hash rounds on it. */
function checkEnvelope(envelope) {
  if (!isEnvelope(envelope)) {
    throw new CryptoError('crypto.bad_envelope', 'that file is not an encrypted model');
  }
  if (envelope.fdtEncrypted > ENVELOPE_VERSION) {
    throw new CryptoError(
      'crypto.from_the_future',
      `this file was encrypted by a newer version of the app (format ` +
        `${envelope.fdtEncrypted}; this build understands ${ENVELOPE_VERSION}).`,
    );
  }
  if (envelope.cipher !== 'AES-GCM') {
    throw new CryptoError('crypto.bad_envelope', `unsupported cipher "${envelope.cipher}"`);
  }

  const kdf = envelope.kdf;
  if (!kdf || typeof kdf !== 'object') {
    throw new CryptoError('crypto.bad_envelope', 'the encrypted file has no key-derivation header');
  }
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new CryptoError('crypto.bad_envelope',
      `unsupported key derivation "${kdf.name}/${kdf.hash}"`);
  }
  // A file claiming a billion iterations would hang the tab; one claiming ten would be a
  // silent downgrade. The tag would catch a tampered count anyway — this catches it first.
  if (!Number.isInteger(kdf.iterations)
    || kdf.iterations < MIN_ITERATIONS
    || kdf.iterations > MAX_ITERATIONS) {
    throw new CryptoError('crypto.bad_envelope',
      `the encrypted file declares an implausible iteration count (${kdf.iterations})`);
  }
}

/**
 * Decrypt an envelope back to text.
 *
 * A wrong password and a tampered file are indistinguishable here, and deliberately so:
 * GCM either authenticates or it does not, and guessing which failed is not information
 * worth leaking. The message names both possibilities.
 */
export async function decryptText(envelope, password) {
  checkEnvelope(envelope);

  const salt = fromBase64(envelope.kdf.salt, 'kdf.salt');
  const iv = fromBase64(envelope.iv, 'iv');
  const ciphertext = fromBase64(envelope.ciphertext, 'ciphertext');

  const key = await deriveKey(password, salt, envelope.kdf.iterations);

  let plaintext;
  try {
    plaintext = await subtle().decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(headerOf(envelope)) },
      key,
      ciphertext,
    );
  } catch (err) {
    throw new CryptoError(
      'crypto.wrong_password',
      'that password did not open the file — either it is wrong, or the file has been ' +
        'altered since it was exported.',
      err,
    );
  }

  return decoder.decode(plaintext);
}
