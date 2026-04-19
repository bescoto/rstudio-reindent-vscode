/**
 * Tests for the blankIndentFor ctx option on reindentLines / reindentRmdChunks.
 *
 * When the Ctrl+I command fires with an empty selection on a blank line, the
 * extension asks the indenter to emit the expected indent for that line via
 * ctx.blankIndentFor. These tests exercise that path directly (no VSCode).
 *
 * Each case also re-runs the input WITHOUT ctx and asserts the blank line is
 * preserved — a regression guard against the new path leaking into formatter
 * or selection-range invocations.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import indenter from '../out/indenter.js';
const { reindentLines, reindentRmdChunks } = indenter;

const DEFAULT_OPTS = { verticalAlign: true, tabWidth: 2 };

function assertBlankIndent(lines, target, expected, opts = DEFAULT_OPTS) {
  const withCtx = reindentLines(lines, opts, { blankIndentFor: target });
  assert.equal(withCtx[target], expected,
    `target line ${target} indent mismatch\n  input:    ${JSON.stringify(lines)}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(withCtx[target])}`);
  assert.equal(withCtx[target].trim(), '', 'target line must remain whitespace-only');

  // Regression: without ctx, the blank line is preserved.
  const withoutCtx = reindentLines(lines, opts);
  assert.equal(withoutCtx[target], lines[target],
    'without ctx the blank line must be preserved');
}

test('blank line after Func(a, — vertical align to "a"', () => {
  assertBlankIndent(['Func(a,', ''], 1, '     ');
});

test('blank first line at top-of-document — empty indent', () => {
  assertBlankIndent([''], 0, '');
});

test('blank line at top level after completed statement — empty indent', () => {
  assertBlankIndent(['x <- 1', ''], 1, '');
});

test('blank line after top-level pipe continuation — chain root + tab', () => {
  assertBlankIndent(
    ['mtcars |>', '  filter(cyl == 4) |>', ''],
    2,
    '  ',
  );
});

test('blank line inside an if-block — one tab from outer indent', () => {
  assertBlankIndent(['if (x) {', ''], 1, '  ');
});

test('blank line after Func(a, with verticalAlign:false — tab-stop fallback', () => {
  assertBlankIndent(
    ['Func(a,', ''],
    1,
    '  ',
    { verticalAlign: false, tabWidth: 2 },
  );
});

test('blank line inside nested call — aligns to inner opener', () => {
  // outer(
  //   inner(x,
  //         <- blank, expect column after "inner("
  // "  inner(" is 8 chars; "(" at col 7; vertical align = col 8.
  assertBlankIndent(
    ['outer(', '  inner(x,', ''],
    2,
    ' '.repeat(8),
  );
});

test('.qmd R chunk — blank line inside chunk gets expected indent', () => {
  const lines = [
    '# prose',
    '```{r}',
    'Func(a,',
    '',
    '```',
    'more prose',
  ];
  const result = reindentRmdChunks(lines, DEFAULT_OPTS, { blankIndentFor: 3 });
  assert.equal(result[3], '     ', 'blank line inside R chunk should get 5-space indent');
  // Other lines untouched (fences, prose, first chunk line).
  assert.equal(result[0], lines[0]);
  assert.equal(result[1], lines[1]);
  assert.equal(result[2], lines[2]);
  assert.equal(result[4], lines[4]);
  assert.equal(result[5], lines[5]);

  const noCtx = reindentRmdChunks(lines, DEFAULT_OPTS);
  assert.equal(noCtx[3], '', 'without ctx the chunk blank line is preserved');
});

test('.qmd prose — blankIndentFor outside any R chunk is a no-op', () => {
  const lines = [
    '# prose',
    '```{r}',
    'Func(a,',
    '',
    '```',
    'more prose',
  ];
  // Target line 0 (prose) — outside any R chunk.
  const result = reindentRmdChunks(lines, DEFAULT_OPTS, { blankIndentFor: 0 });
  assert.deepEqual(result, lines,
    'prose target produces identical output to input');
});
