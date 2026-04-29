/**
 * Dump diffs for every xfail fixture in the format used by
 * known_failures_diffs.txt at the repo root.
 *
 * Usage:
 *   npm run compile
 *   node test/dump-xfail-diffs.mjs > known_failures_diffs.txt
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const blocks = [];

for (const file of walk(FIXTURE_ROOT)) {
  const id = fixtureId(file);
  if (!knownFailures.has(id)) continue;

  const text = readFileSync(file, 'utf8');
  const expected = text.split(/\r?\n/);
  if (expected.length && expected[expected.length - 1] === '') expected.pop();

  const flat = flatten(expected);
  const actual = reindentLines(flat, { verticalAlign: true, tabWidth: 2 });

  if (arraysEqual(actual, expected)) continue;

  const lines = [];
  lines.push(`=== ${id} ===`);
  lines.push('Expected:');
  expected.forEach((l, i) => lines.push(`${i + 1}: "${l}"`));
  lines.push('Actual:');
  actual.forEach((l, i) => lines.push(`${i + 1}: "${l}"`));
  lines.push('Diffs:');
  const max = Math.max(expected.length, actual.length);
  for (let i = 0; i < max; i++) {
    const e = expected[i] ?? '';
    const a = actual[i] ?? '';
    if (e !== a) {
      lines.push(`Line ${i + 1}: Expected: "${e}" | Actual: "${a}"`);
    }
  }
  blocks.push(lines.join('\n'));
}

process.stdout.write(blocks.join('\n\n') + '\n');
