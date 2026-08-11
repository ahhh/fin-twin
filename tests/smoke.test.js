import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exists, readRepoFile } from './helpers/files.js';

test('the static site has the files GitHub Pages needs', async () => {
  for (const file of ['index.html', 'app.js', 'styles.css', '.nojekyll']) {
    assert.ok(await exists(file), `missing ${file}`);
  }
});

test('index.html loads app.js as a module and nothing inline', async () => {
  const html = await readRepoFile('index.html');
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);

  // An inline <script> body would be blocked by the CSP at runtime; fail here instead,
  // where the message can explain why.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  assert.deepEqual(inline, [], 'inline <script> blocks are blocked by the CSP');
});

test('the disclaimer and the privacy statement are both on the page', async () => {
  const html = await readRepoFile('index.html');
  assert.match(html, /not tax, legal, accounting or\s+investment advice/i);
  assert.match(html, /data stays in this browser/i);
});
