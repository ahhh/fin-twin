/** Load the shipped rule packs from disk for tests (the browser fetches them instead). */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './files.js';
import { assertValidPack } from '../../model/tax/rule-pack.js';

export async function loadPackFromDisk(year, { country = 'us', level = 'federal' } = {}) {
  const path = join(REPO_ROOT, 'data', 'tax', country, level, `${year}.json`);
  return assertValidPack(JSON.parse(await readFile(path, 'utf8')));
}

export const PACK_2026 = await loadPackFromDisk(2026);
export const PACKS = [PACK_2026];

/** A book for one person, in the shape the tax pass produces. */
export function book(categories, personId = 'p1') {
  return { [personId]: categories };
}
