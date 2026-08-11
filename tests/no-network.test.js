/**
 * The privacy claim in the footer — "Your data stays in this browser" — has to be a
 * property of the code, not a promise in the copy. These tests fail the build if any
 * first-party shipped file can talk to another origin.
 *
 * vendor/ is deliberately NOT scanned: its integrity is pinned by tests/vendor.test.js,
 * and Chart.js legitimately carries its homepage URL in a licence banner.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk, readRepoFile, locate } from './helpers/files.js';

/** Files that ship to the browser and that we wrote ourselves. */
async function shippedFirstPartyFiles() {
  const found = [
    ...(await walk('model', (n) => n.endsWith('.js'))),
    ...(await walk('ui', (n) => n.endsWith('.js'))),
    'app.js',
    'index.html',
  ];
  return found;
}

// `rule-pack.js` fetches the tax packs, which are same-origin static JSON. It is the one
// module allowed to touch the network API at all.
const FETCH_ALLOWLIST = new Set(['model/tax/rule-pack.js', 'model/persistence.js']);

test('no shipped first-party file references an external origin', async () => {
  const offenders = [];
  for (const file of await shippedFirstPartyFiles()) {
    const text = await readRepoFile(file);
    for (const m of text.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) {
      // Same-origin localhost references in comments are fine (dev instructions).
      if (/^https?:\/\/localhost([:/]|$)/.test(m[0])) continue;
      offenders.push(`${locate(file, text, m.index)}  ->  ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `External URLs found in shipped code. Vendor the resource instead:\n${offenders.join('\n')}`,
  );
});

test('no shipped file uses a network API outside the allowlist', async () => {
  const offenders = [];
  const banned = /\b(XMLHttpRequest|WebSocket|EventSource|importScripts)\b|navigator\.sendBeacon|\bfetch\s*\(/g;

  for (const file of await shippedFirstPartyFiles()) {
    if (FETCH_ALLOWLIST.has(file)) continue;
    const text = await readRepoFile(file);
    for (const m of text.matchAll(banned)) {
      offenders.push(`${locate(file, text, m.index)}  ->  ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Network APIs used outside the allowlist (${[...FETCH_ALLOWLIST].join(', ')}):\n` +
      offenders.join('\n'),
  );
});

test('index.html carries a Content-Security-Policy that locks the page to its own origin', async () => {
  const html = await readRepoFile('index.html');
  const match = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i,
  );
  assert.ok(match, 'index.html has no Content-Security-Policy meta tag');

  const policy = match[1];
  for (const directive of [
    "default-src 'self'",
    "connect-src 'self'",
    "script-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
  ]) {
    assert.ok(policy.includes(directive), `CSP is missing: ${directive}`);
  }
  assert.ok(!policy.includes('unsafe-inline'), 'CSP must not allow unsafe-inline');
  assert.ok(!policy.includes('unsafe-eval'), 'CSP must not allow unsafe-eval');
});
