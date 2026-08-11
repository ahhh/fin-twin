/**
 * Architectural guard: no tax constant lives in code.
 *
 * Brackets, limits and thresholds belong in `data/tax/**`, versioned and dated, so that
 * when the law changes there is one obvious place to change and a `lastVerified` date that
 * makes staleness visible. A threshold buried in a `.js` file is invisible when it goes
 * out of date, and the answer stays confident and wrong.
 *
 * The guard is deliberately a speed bump: adding a genuinely non-tax number to these
 * modules means adding it to the allowlist with a reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk, readRepoFile, locate, stripCommentsAndStrings } from './helpers/files.js';

/**
 * Numbers that are structural rather than fiscal.
 *   0, 1, 2   arithmetic and indexing
 *   100       cents-per-dollar, and the marginal-rate probe of one dollar
 *   0.5       halving is structural (the probe midpoint), not a tax rate
 *   12        months in a year
 */
const ALLOWED = new Set(['0', '1', '2', '100', '0.5', '12']);

test('no tax rate, bracket or threshold is hard-coded in model/tax', async () => {
  const files = await walk('model/tax', (n) => n.endsWith('.js'));
  assert.ok(files.length >= 4, 'expected the tax modules to exist');

  const offenders = [];
  for (const file of files) {
    const code = stripCommentsAndStrings(await readRepoFile(file));

    // Any decimal literal, or any integer of four digits or more.
    for (const match of code.matchAll(/(?<![\w.])(\d+\.\d+|\d{4,})(?![\w.])/g)) {
      const literal = match[1];
      if (ALLOWED.has(literal)) continue;
      offenders.push(
        `${locate(file, code, match.index)}  ${literal}  — put it in data/tax/**, or add it ` +
        'to ALLOWED in this test with a reason',
      );
    }
  }

  assert.deepEqual(offenders, [], `hard-coded numbers in the tax engine:\n${offenders.join('\n')}`);
});

test('the tax modules read their figures from a pack argument', async () => {
  // Every module that computes money should take a `pack`. If one stops doing so, it has
  // started to know something it should be told.
  for (const file of ['model/tax/federal.js', 'model/tax/payroll.js', 'model/tax/estimated.js']) {
    const code = await readRepoFile(file);
    assert.match(code, /\bpack\b/, `${file} does not reference a rule pack`);
  }
});
