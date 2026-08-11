import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, readRepoFile } from './helpers/files.js';

const manifest = JSON.parse(await readRepoFile('vendor/VERSION.json'));

test('every vendored package matches its pinned sha256', async () => {
  assert.ok(manifest.packages.length > 0, 'manifest lists no packages');

  for (const pkg of manifest.packages) {
    const bytes = await readFile(join(REPO_ROOT, 'vendor', pkg.file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(
      digest,
      pkg.sha256,
      `${pkg.name}@${pkg.version} (${pkg.file}) does not match the pinned hash. ` +
        'If you upgraded it on purpose, update vendor/VERSION.json and re-check the licence.',
    );
  }
});

test('every vendored package ships its licence', async () => {
  for (const pkg of manifest.packages) {
    const licence = await readRepoFile(join('vendor', pkg.licenseFile));
    assert.ok(licence.trim().length > 50, `${pkg.name} licence file looks empty`);
  }
});
