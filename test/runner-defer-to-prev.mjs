/**
 * Tests for the "defer to previous line(s)" behavior on partial-range reindent.
 *
 * When the caller passes ctx.targetStart/targetEnd, lines outside that range
 * are preserved verbatim and later target lines inside the same bracket defer
 * to those preserved indents. This lets Ctrl+I on a single line match an
 * earlier arg that the user manually positioned, instead of snapping back to
 * the algorithmic vertical-align column.
 *
 * See reindent-notes/Incremental parsing.txt for the motivating example.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import indenter from '../out/indenter.js';
const { reindentLines } = indenter;

const DEFAULT_OPTS = { verticalAlign: true, tabWidth: 2 };

test('target=arg3 only — arg3 matches user-positioned arg2, not the opener column', () => {
  // From reindent-notes/Incremental parsing.txt:
  //   MyFunc(arg1,
  //      arg2,          <- user put arg2 at col 3
  //   arg3)             <- target: should match arg2, not col 7
  const lines = [
    'MyFunc(arg1,',
    '   arg2,',
    'arg3)',
  ];
  const result = reindentLines(lines, DEFAULT_OPTS, { targetStart: 2, targetEnd: 2 });
  assert.deepEqual(result, [
    'MyFunc(arg1,',
    '   arg2,',     // preserved (outside target)
    '   arg3)',     // deferred to arg2's col 3, not vertical-aligned to col 7
  ]);
});

test('target=full doc — defer is inert, vertical-align wins', () => {
  // Same input, but with the whole document in scope: nothing to defer to,
  // all three lines are reindented, so the expected output is the canonical
  // vertical-aligned layout.
  const lines = [
    'MyFunc(arg1,',
    '   arg2,',
    'arg3)',
  ];
  const result = reindentLines(lines, DEFAULT_OPTS, { targetStart: 0, targetEnd: 2 });
  assert.deepEqual(result, [
    'MyFunc(arg1,',
    '       arg2,',
    '       arg3)',
  ]);
});

test('target=arg3 only — no targetRange is equivalent to full reindent', () => {
  // Omitting targetStart/targetEnd preserves the pre-existing full-doc
  // behavior: everything is reindented, nothing is deferred.
  const lines = [
    'MyFunc(arg1,',
    '   arg2,',
    'arg3)',
  ];
  const result = reindentLines(lines, DEFAULT_OPTS);
  assert.deepEqual(result, [
    'MyFunc(arg1,',
    '       arg2,',
    '       arg3)',
  ]);
});

test('defer honors leading-op shift — op-led line sits one column right of prev', () => {
  // arg2 is preserved at col 3; arg3 starts with a leading `+`, so it should
  // sit at col 4 (one past arg2's content column) per ESS-style alignment.
  const lines = [
    'MyFunc(arg1,',
    '   arg2,',
    '+ arg3)',
  ];
  const result = reindentLines(lines, DEFAULT_OPTS, { targetStart: 2, targetEnd: 2 });
  assert.deepEqual(result, [
    'MyFunc(arg1,',
    '   arg2,',
    '    + arg3)',  // col 4 = arg2's col 3 + 1 for leading-op shift
  ]);
});

test('hanging paren — leading-op gets +tab over prev arg, fresh arg realigns with it', () => {
  // From temp.r: user manually indented `manual_arg1` at col 17 inside a
  // hanging `(`. The next two lines should be:
  //   `+ foo,`  — leading-op continuation, one tab past prev arg → col 19
  //   `arg2)`   — fresh comma-arg, realigns with manual_arg1     → col 17
  // (i.e. the comma-arg ignores the intermediate continuation line and
  // anchors back to the most recent non-continuation sibling.)
  const expected = [
    'VeryLongFunctionName(',
    '                 manual_arg1',
    '                   + foo,',
    '                 arg2)',
  ];

  // Step 1: lines 0–1 already user-positioned; reindent only line 2.
  let buf = [expected[0], expected[1], '+ foo,', 'arg2)'];
  buf = reindentLines(buf, DEFAULT_OPTS, { targetStart: 2, targetEnd: 2 });
  assert.equal(buf[2], expected[2],
    `line 2: expected ${JSON.stringify(expected[2])}, got ${JSON.stringify(buf[2])}`);

  // Step 2: with line 2 now in expected form, reindent only line 3.
  buf[3] = 'arg2)';
  buf = reindentLines(buf, DEFAULT_OPTS, { targetStart: 3, targetEnd: 3 });
  assert.equal(buf[3], expected[3],
    `line 3: expected ${JSON.stringify(expected[3])}, got ${JSON.stringify(buf[3])}`);
});

test('nested bracket — target in outer defers to outer arg, not nested one', () => {
  // Line 4 (`arg_b)`) is inside outer `(`, not inside the nested `foo(` that
  // opened on line 2 and closed on line 3. Its defer anchor should be the
  // last OUTER arg — line 1 at col 3 — not line 3's col 4.
  const lines = [
    'outer(arg_a,',
    '   foo(x,',
    '       y),',
    'arg_b)',
  ];
  const result = reindentLines(lines, DEFAULT_OPTS, { targetStart: 3, targetEnd: 3 });
  assert.equal(result[3], '   arg_b)',
    `line 3 should defer to outer arg at col 3; got ${JSON.stringify(result[3])}`);
});
