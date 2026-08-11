/**
 * Architectural guard: `Date` is constructed in exactly one place.
 *
 * `new Date('2026-08-31')` parses as UTC midnight while `.getMonth()` reads local time, so
 * west of UTC that date *is* 30 August. A monthly salary then emits 59 or 61 paychecks over
 * a five-year projection, and nobody notices until a golden file shifts. Every date in this
 * model is a 'YYYY-MM-DD' string and every operation on one is integer arithmetic.
 *
 * `model/dates.js` is exempt, and only for `todayISO()`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walk, readRepoFile, locate, stripCommentsAndStrings } from './helpers/files.js';

const EXEMPT = new Set(['model/dates.js']);

const BANNED = [
  [/\bnew Date\s*\(/g, 'new Date(', 'use model/dates.js — parseISO/addDays/addMonths'],
  [/\bDate\.parse\s*\(/g, 'Date.parse(', 'use parseISO from model/dates.js'],
  [/\bDate\.now\s*\(/g, 'Date.now(', 'the engine must not read the clock; use todayISO() at the UI edge'],
  [/\bDate\.UTC\s*\(/g, 'Date.UTC(', 'use daysFromCivil from model/dates.js'],
  [/\.getMonth\s*\(/g, '.getMonth()', 'reads local time from a UTC-parsed value — use parseISO'],
  [/\.getFullYear\s*\(/g, '.getFullYear()', 'reads local time from a UTC-parsed value — use parseISO'],
  [/\.getDate\s*\(/g, '.getDate()', 'reads local time from a UTC-parsed value — use parseISO'],
  [/\.setMonth\s*\(/g, '.setMonth()', '31 Jan + 1 month lands on 3 March — use addMonths'],
  [/\.setDate\s*\(/g, '.setDate()', 'use addDays from model/dates.js'],
  [/\.toISOString\s*\(/g, '.toISOString()', 'converts through UTC — use toISO from model/dates.js'],
];

test('no shipped module constructs or reads a Date outside model/dates.js', async () => {
  const files = [
    ...(await walk('model', (n) => n.endsWith('.js'))),
    ...(await walk('ui', (n) => n.endsWith('.js'))),
    'app.js',
  ].filter((f) => !EXEMPT.has(f));

  const offenders = [];
  for (const file of files) {
    // Scan code only: a comment explaining why `new Date` is banned must not trip the guard.
    const text = stripCommentsAndStrings(await readRepoFile(file));
    for (const [pattern, label, advice] of BANNED) {
      for (const m of text.matchAll(pattern)) {
        offenders.push(`${locate(file, text, m.index)}  ${label}  — ${advice}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Date used outside model/dates.js:\n${offenders.join('\n')}`);
});

test('model/dates.js confines its Date use to todayISO', async () => {
  const raw = await readRepoFile('model/dates.js');
  const text = stripCommentsAndStrings(raw);

  const uses = [...text.matchAll(/\bnew Date\s*\(/g)];
  assert.equal(uses.length, 1, 'dates.js should construct exactly one Date, inside todayISO()');

  // That one construction must be inside todayISO, not somewhere the engine can reach.
  const todayAt = text.indexOf('export function todayISO');
  assert.ok(todayAt > -1, 'todayISO() is missing');
  assert.ok(
    uses[0].index > todayAt,
    'the single Date construction is outside todayISO() — the engine must not read the clock',
  );
});
