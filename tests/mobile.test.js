/**
 * Guards for the phone layout.
 *
 * Pixel layout is not testable here and is not the point. What these catch is the small
 * set of mistakes that make a page unusable on a phone in a way that is invisible on a
 * desktop — content stranded under a fixed tab bar, a form that zooms the viewport the
 * moment it is focused — and that a well-meaning CSS tidy-up would otherwise undo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoFile } from './helpers/files.js';

const css = await readRepoFile('styles.css');
const html = await readRepoFile('index.html');

test('the page is laid out at device width and may paint under the notch', () => {
  const meta = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);
  assert.ok(meta, 'index.html has no viewport meta tag');
  assert.match(meta[1], /width=device-width/);
  assert.match(meta[1], /viewport-fit=cover/,
    'without viewport-fit=cover the safe-area insets are always zero');
});

test('the tab bar clears the home indicator', () => {
  assert.match(css, /env\(safe-area-inset-bottom/,
    'a fixed bottom bar must pad itself out of the way of the home indicator');
});

test('content is not left stranded underneath the fixed tab bar', () => {
  // The bar's height and the space reserved for it come from the same custom property,
  // so moving one moves the other.
  assert.match(css, /padding-bottom:\s*calc\(var\(--nav-height\)/);
  assert.match(css, /height:\s*var\(--nav-height\)/);
});

test('touch targets are finger-sized and inputs do not trigger the iOS zoom', () => {
  const coarse = css.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/);
  assert.ok(coarse, 'there is no touch-pointer block at all');

  assert.match(coarse[0], /min-height:\s*44px/, '44px is the smallest reliably tappable target');
  // Safari zooms into any focused control below 16px and does not zoom back out, which
  // strands the user mid-form with the rest of the page off-screen.
  assert.match(coarse[0], /font-size:\s*16px/);
});

test('every section stays reachable on a phone', () => {
  // The mobile layout reshapes the navigation; it must never drop an entry from it.
  const views = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    views,
    ['dashboard', 'income', 'expenses', 'taxes', 'scenarios', 'assumptions'],
    'the phone layout is the same app, so it offers the same sections',
  );
});
