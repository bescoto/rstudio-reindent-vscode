/**
 * Fixture-based test runner for the indenter.
 *
 * For each `test/fixtures/<section>/<case>.R`:
 *   1. Read the file — this is the expected (correctly indented) output.
 *   2. Flatten it by stripping all leading whitespace from non-blank lines.
 *   3. Run it through `reindentLines` with default options.
 *   4. Assert the result matches the expected output exactly.
 *
 * Cases that are known to diverge from upstream RStudio/ESS behavior are
 * listed in test/known-failures.txt; they're run as expect-fail — if they
 * start passing, the runner fails and prompts you to remove them from the list.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import indenter from '../out/indenter.js';
const { reindentLines } = indenter;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures');
const KNOWN_FAILURES_FILE = join(HERE, 'known-failures.txt');

const knownFailures = new Set(
  existsSync(KNOWN_FAILURES_FILE)
    ? readFileSync(KNOWN_FAILURES_FILE, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*/, '').trim())
        .filter(Boolean)
    : [],
);

function* walk(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (p.endsWith('.R')) yield p;
  }
}

function fixtureId(absPath) {
  return relative(FIXTURE_ROOT, absPath).replace(/\.R$/, '').split(sep).join('/');
}

function flatten(lines) {
  return lines.map((l) => (l.trim() === '' ? l : l.replace(/^\s+/, '')));
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const seenIds = new Set();
for (const file of walk(FIXTURE_ROOT)) {
  const id = fixtureId(file);
  seenIds.add(id);
  const xfail = knownFailures.has(id);

  test(id, () => {
    const text = readFileSync(file, 'utf8');
    // Fixtures end with a trailing newline; splitting produces a final "".
    // Strip it so reindent sees the exact line set the fixture represents.
    const expected = text.split(/\r?\n/);
    if (expected.length && expected[expected.length - 1] === '') expected.pop();

    const flat = flatten(expected);
    const actual = reindentLines(flat, { verticalAlign: true, tabWidth: 2 });

    if (xfail) {
      if (arraysEqual(actual, expected)) {
        assert.fail(
          `xfail now passes — remove ${id} from test/known-failures.txt`,
        );
      }
      return;
    }
    assert.deepEqual(actual, expected);
  });
}

// Stale-entry check: every ID in known-failures.txt must correspond to a real fixture.
for (const id of knownFailures) {
  if (!seenIds.has(id)) {
    test(`known-failures.txt: stale entry "${id}"`, () => {
      assert.fail(`known-failures.txt references missing fixture: ${id}`);
    });
  }
}
