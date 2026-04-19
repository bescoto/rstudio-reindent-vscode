/**
 * Regenerate test/known-failures.txt from the current state of the indenter.
 *
 * Usage:
 *   npm run compile && node test/update-known-failures.mjs
 *
 * For every fixture under test/fixtures/, runs the same reindent-and-compare
 * the runner does. Any fixture whose output does not match upstream is
 * written into known-failures.txt, grouped by section directory. The header
 * comment block at the top of the file is preserved.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import indenter from '../out/indenter.js';
const { reindentLines } = indenter;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures');
const KNOWN_FAILURES_FILE = join(HERE, 'known-failures.txt');

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

// Collect all fixture IDs and per-section failure sets.
const sections = new Map(); // section name -> { all: Set, fail: Set }
for (const file of walk(FIXTURE_ROOT)) {
  const id = fixtureId(file);
  const section = id.includes('/') ? id.slice(0, id.indexOf('/')) : '';
  if (!sections.has(section)) sections.set(section, { all: new Set(), fail: new Set() });
  sections.get(section).all.add(id);

  const text = readFileSync(file, 'utf8');
  const expected = text.split(/\r?\n/);
  if (expected.length && expected[expected.length - 1] === '') expected.pop();
  const flat = flatten(expected);
  const actual = reindentLines(flat, { verticalAlign: true, tabWidth: 2 });
  if (!arraysEqual(actual, expected)) sections.get(section).fail.add(id);
}

// Preserve the existing header comment block (everything up to the first
// `# <section>` line that matches a real section directory).
const existing = readFileSync(KNOWN_FAILURES_FILE, 'utf8').split(/\r?\n/);
const sectionNames = new Set([...sections.keys()].filter(Boolean));
let headerEnd = existing.length;
for (let i = 0; i < existing.length; i++) {
  const m = existing[i].match(/^# ([A-Za-z0-9_-]+)\s*$/);
  if (m && sectionNames.has(m[1])) {
    headerEnd = i;
    break;
  }
}
const header = existing.slice(0, headerEnd).join('\n').replace(/\n+$/, '');

// Natural sort so `10` comes after `9`, matching test output ordering.
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const aa = a.match(re) || [];
  const bb = b.match(re) || [];
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const an = Number(aa[i]);
    const bn = Number(bb[i]);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (aa[i] !== bb[i]) {
      return aa[i] < bb[i] ? -1 : 1;
    }
  }
  return aa.length - bb.length;
}

const sectionOrder = [...sections.keys()].filter(Boolean).sort();

const out = [header, ''];
for (const section of sectionOrder) {
  const { fail } = sections.get(section);
  out.push(`# ${section}`);
  const ids = [...fail].sort(naturalCompare);
  for (const id of ids) out.push(id);
  out.push('');
}

writeFileSync(KNOWN_FAILURES_FILE, out.join('\n'));

const total = [...sections.values()].reduce((n, s) => n + s.all.size, 0);
const failed = [...sections.values()].reduce((n, s) => n + s.fail.size, 0);
console.log(`Wrote ${KNOWN_FAILURES_FILE}`);
console.log(`  ${failed} failing / ${total} total fixtures`);
