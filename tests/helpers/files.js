import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Recursively collect files under `dir` (repo-relative) whose name matches `filter`. */
export async function walk(dir, filter = () => true) {
  const abs = join(REPO_ROOT, dir);
  const out = [];
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(child, filter)));
    else if (filter(entry.name)) out.push(child);
  }
  return out;
}

/** Read a repo-relative file as text. */
export function readRepoFile(relPath) {
  return readFile(join(REPO_ROOT, relPath), 'utf8');
}

/** Read a repo-relative file as text, or return null when it does not exist. */
export async function readRepoFileIfPresent(relPath) {
  try {
    return await readRepoFile(relPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function exists(relPath) {
  try {
    await stat(join(REPO_ROOT, relPath));
    return true;
  } catch {
    return false;
  }
}

/** Report a match as `path:line` so failures are clickable. */
export function locate(relPath, text, index) {
  const line = text.slice(0, index).split('\n').length;
  return `${relative('.', relPath)}:${line}`;
}

/**
 * Blank out comments and string bodies, replacing them with spaces so character offsets —
 * and therefore the line numbers `locate` reports — stay correct.
 *
 * The architectural guards scan for banned constructs, and a module that *explains* why a
 * construct is banned should not trip its own guard. Regex literals are not tracked; none
 * of our source contains a regex holding `//` or `/*`.
 */
export function stripCommentsAndStrings(text) {
  const out = [...text];
  let state = 'code';
  let quote = '';

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c === '/' && next === '*') { state = 'block'; out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; }
    } else if (state === 'line') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
    } else if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c !== '\n') out[i] = ' ';
    } else if (state === 'string') {
      if (c === '\\') { out[i] = ' '; out[i + 1] = ' '; i++; }
      else if (c === quote) state = 'code';
      else if (c !== '\n') out[i] = ' ';
    }
  }
  return out.join('');
}
