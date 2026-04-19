import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import indenter from './out/indenter.js';
const { reindentLines } = indenter;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_ROOT = join(HERE, 'test', 'fixtures');
const KNOWN_FAILURES_FILE = join(HERE, 'test', 'known-failures.txt');

const knownFailures = new Set(
  readFileSync(KNOWN_FAILURES_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
);

function flatten(lines) {
  return lines.map((l) => (l.trim() === '' ? l : l.replace(/^\s+/, '')));
}

function diffLines(expected, actual) {
  const maxLen = Math.max(expected.length, actual.length);
  const diffs = [];
  for (let i = 0; i < maxLen; i++) {
    const exp = expected[i] || '';
    const act = actual[i] || '';
    if (exp !== act) {
      diffs.push(`Line ${i+1}: Expected: ${JSON.stringify(exp)} | Actual: ${JSON.stringify(act)}`);
    }
  }
  return diffs;
}

for (const id of knownFailures) {
  const file = join(FIXTURE_ROOT, `${id}.R`);
  const text = readFileSync(file, 'utf8');
  const expected = text.split(/\r?\n/);
  if (expected.length && expected[expected.length - 1] === '') expected.pop();

  const flat = flatten(expected);
  const actual = reindentLines(flat, { verticalAlign: true, tabWidth: 2 });

  console.log(`\n=== ${id} ===`);
  console.log('Expected:');
  expected.forEach((line, i) => console.log(`${i+1}: ${JSON.stringify(line)}`));
  console.log('Actual:');
  actual.forEach((line, i) => console.log(`${i+1}: ${JSON.stringify(line)}`));

  const diffs = diffLines(expected, actual);
  if (diffs.length > 0) {
    console.log('Diffs:');
    diffs.forEach(d => console.log(d));
  } else {
    console.log('No diffs (unexpected, since it\'s a known failure)');
  }
}