/**
 * Line-at-a-time reindent: simulates the user pressing Ctrl+I on each line of
 * a document in turn, the way the editor command path actually invokes the
 * indenter (see computeEdits in src/extension.ts — full document goes in,
 * but only the cursor's line is in the target range).
 *
 * Mirrors test/fixtures/continuation-lines/2.R, which the standard fixture
 * runner exercises in one shot. Here we start from the flattened input and
 * walk down line-by-line, asking reindentLines to fix only the current line
 * while the rest stays as it currently sits — a much closer model of the
 * interactive editing flow.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import indenter from '../out/indenter.js';
const { reindentLines } = indenter;

const DEFAULT_OPTS = { verticalAlign: true, tabWidth: 2 };

const EXPECTED = [
  '{',
  '  foo %>%',
  '    bar %>%',
  '    baz',
  '} %>%',
  '  thing1 %>%',
  '  thing2',
];

function flatten(lines) {
  return lines.map((l) => (l.trim() === '' ? l : l.replace(/^\s+/, '')));
}

test('continuation-lines/2 — reindent each line in order, top to bottom', () => {
  let buf = flatten(EXPECTED);
  for (let i = 0; i < buf.length; i++) {
    buf = reindentLines(buf, DEFAULT_OPTS, { targetStart: i, targetEnd: i });
  }
  assert.deepEqual(buf, EXPECTED);
});

test('continuation-lines/2 — each line is correct given prior lines already indented', () => {
  // Tighter check: at step N, lines 0..N-1 are already in their final form,
  // line N is flat, lines N+1.. are flat. After reindenting line N alone,
  // line N must equal EXPECTED[N]. Catches per-line drift that a
  // top-to-bottom rewrite could mask by compounding errors.
  for (let i = 0; i < EXPECTED.length; i++) {
    const buf = [
      ...EXPECTED.slice(0, i),
      ...flatten(EXPECTED.slice(i)),
    ];
    const result = reindentLines(buf, DEFAULT_OPTS, { targetStart: i, targetEnd: i });
    assert.equal(
      result[i],
      EXPECTED[i],
      `line ${i}: expected ${JSON.stringify(EXPECTED[i])}, got ${JSON.stringify(result[i])}`,
    );
  }
});
