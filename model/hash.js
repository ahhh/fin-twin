/**
 * Canonical serialisation and a fast non-cryptographic digest.
 *
 * Used for `runKey` (so two runs can be compared for byte-identity rather than
 * approximate agreement) and for golden-file digests. Not used for anything security
 * related — FNV-1a is a hash, not a MAC.
 *
 * The point of canonicalisation is that `{a:1,b:2}` and `{b:2,a:1}` are the same model and
 * must produce the same key. Without that, "a scenario with no overrides equals base" can
 * only be tested approximately, and approximate equality hides real bugs.
 */

export class HashError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HashError';
    this.code = code;
  }
}

/**
 * JSON with object keys sorted at every depth.
 *
 * Rejects values JSON cannot round-trip faithfully — NaN, Infinity and undefined inside
 * arrays all serialise to something that reads back differently, which would make a
 * "determinism" test pass while the underlying data differed.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value, path = '$') {
  if (value === null) return null;

  const type = typeof value;

  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new HashError('hash.not_finite', `cannot canonicalise ${value} at ${path}`);
    }
    // -0 and 0 stringify differently but compare equal; normalise so hashes agree.
    return value === 0 ? 0 : value;
  }
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'undefined') {
    throw new HashError('hash.undefined', `cannot canonicalise undefined at ${path}`);
  }
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new HashError('hash.unsupported_type', `cannot canonicalise a ${type} at ${path}`);
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => canonicalise(item, `${path}[${i}]`));
  }

  // Plain objects only. A Map or a Date would serialise to `{}` and silently lose data.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new HashError(
      'hash.not_plain_object',
      `cannot canonicalise a ${value.constructor?.name ?? 'non-plain object'} at ${path} — ` +
        'it would serialise to {} and lose its contents',
    );
  }

  const out = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) continue; // matches JSON.stringify's own object behaviour
    out[key] = canonicalise(child, `${path}.${key}`);
  }
  return out;
}

/**
 * FNV-1a, 64-bit, returned as 16 lowercase hex characters.
 *
 * Implemented in two 32-bit halves because JavaScript bitwise operators are 32-bit and
 * BigInt is roughly an order of magnitude slower here — this runs over every event of
 * every run.
 */
export function fnv1a64(input) {
  const text = typeof input === 'string' ? input : String(input);

  // Offset basis 14695981039346656037 = 0xcbf29ce4 84222325
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // XOR the low byte(s). Code units above 0xFF contribute both bytes, so non-ASCII
    // labels still affect the digest.
    lo ^= code & 0xff;
    if (code > 0xff) hi ^= (code >>> 8) & 0xff;

    // Multiply by the FNV prime 1099511628211 = 2^40 + 2^8 + 0xb3.
    const lo16 = lo & 0xffff;
    const lo32 = lo >>> 16;

    const p0 = lo16 * 0x1b3;
    const p1 = lo32 * 0x1b3 + (p0 >>> 16);

    let nextLo = ((p1 & 0xffff) << 16) | (p0 & 0xffff);
    let nextHi = (hi * 0x1b3 + (p1 >>> 16)) >>> 0;

    // + lo * 2^40 and + hi * 2^40, folded into the high half.
    nextHi = (nextHi + ((lo << 8) >>> 0)) >>> 0;

    hi = nextHi >>> 0;
    lo = nextLo >>> 0;
  }

  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** Canonicalise then digest. The two are almost always used together. */
export function digest(value) {
  return fnv1a64(canonicalJson(value));
}

/**
 * The identity of a projection: same model, same options, same key.
 *
 * Only the fields that can change the numbers go in. Cosmetic things — a source's `notes`,
 * a scenario's `description` — deliberately do not, so renaming something does not read as
 * a different financial outcome.
 */
export function runKeyFor(events) {
  return digest(
    events.map((e) => ({
      id: e.id,
      account: e.account,
      cashAmount: e.cashAmount,
      taxableAmount: e.taxableAmount,
      taxCategory: e.taxCategory,
      taxYear: e.taxYear,
      kind: e.kind,
      phase: e.phase,
      personId: e.personId,
      groupId: e.groupId,
      category: e.category,
      probability: e.probability,
      realization: e.realization,
    })),
  );
}
