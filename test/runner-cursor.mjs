/**
 * Tests for adjustCursorAfterReindent — the pure cursor-positioning helper
 * used by the Ctrl+I single-line path.
 *
 * Two regimes:
 *   • Cursor at or before the start of non-whitespace → snaps to the new
 *     start-of-non-whitespace (end of the new indent).
 *   • Cursor inside the non-whitespace → its offset within that content is
 *     preserved across the indent change.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import cursor from '../out/cursor.js';
const { adjustCursorAfterReindent } = cursor;

test('cursor before non-whitespace lands at new start-of-content (indent grew)', () => {
  // "foo()" → "    foo()". Cursor at col 0 (in the leading whitespace, which
  // here is empty) should follow the content to col 4.
  const oldLine = 'foo()';
  const newLine = '    foo()';
  assert.equal(adjustCursorAfterReindent(oldLine, newLine, 0), 4);
});

test('cursor at start of non-whitespace lands at new start-of-content (indent shrank)', () => {
  // "      foo()" → "  foo()". Cursor at col 6 (exactly at "f") snaps to the
  // new start-of-content at col 2.
  const oldLine = '      foo()';
  const newLine = '  foo()';
  assert.equal(adjustCursorAfterReindent(oldLine, newLine, 6), 2);
});

test('cursor inside leading whitespace lands at new start-of-content', () => {
  // Cursor in the middle of the old indent — still "before non-whitespace",
  // so it snaps to the start of content on the reindented line.
  const oldLine = '      foo()';
  const newLine = '  foo()';
  assert.equal(adjustCursorAfterReindent(oldLine, newLine, 3), 2);
});

test('cursor inside non-whitespace preserves offset relative to content (indent grew)', () => {
  // "foo()" → "    foo()". Cursor at col 2 (the second "o") was 2 chars into
  // the content; should remain 2 chars into the content → col 4 + 2 = 6.
  const oldLine = 'foo()';
  const newLine = '    foo()';
  assert.equal(adjustCursorAfterReindent(oldLine, newLine, 2), 6);
});

test('cursor inside non-whitespace preserves offset relative to content (indent shrank)', () => {
  // "      foo(x)" → "  foo(x)". Cursor at col 10 (the "x") was 4 chars into
  // the content; should stay 4 chars into the content → col 2 + 4 = 6.
  const oldLine = '      foo(x)';
  const newLine = '  foo(x)';
  assert.equal(adjustCursorAfterReindent(oldLine, newLine, 10), 6);
});

test('cursor at end of non-whitespace tracks to end of new content', () => {
  const oldLine = 'foo()';
  const newLine = '    foo()';
  // col 5 = past the closing ")", i.e. at end of content (5 chars in).
  assert.equal(adjustCursorAfterReindent(oldLine, newLine, 5), 9);
});
