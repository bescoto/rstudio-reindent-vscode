#!/usr/bin/env node
/**
 * One-shot splitter: carve an ESS-style RStudio reference file into
 * per-case fixture files under test/fixtures/<section>/<case>.R.
 *
 * The reference format is:
 *   ### Section name
 *   ## caseId
 *   <case body>
 *   ## nextCaseId
 *   <case body>
 *   ### Next section
 *
 * Re-run manually when the upstream ESS file is updated:
 *   node test/split-ess.mjs <path-to-RStudio-.R> test/fixtures
 *
 * Not part of `npm test` — fixtures are checked into the repo.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [, , srcPath, outDir] = process.argv;
if (!srcPath || !outDir) {
  console.error('usage: node test/split-ess.mjs <ess-file> <out-dir>');
  process.exit(2);
}

const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const text = readFileSync(srcPath, 'utf8');
const lines = text.split(/\r?\n/);

let section = null;
let caseId = null;
let buf = [];
const written = new Map(); // "section/caseId" -> collision counter

function flush() {
  if (!section || !caseId) { buf = []; return; }
  // Trim trailing blank lines inside the case body.
  while (buf.length && buf[buf.length - 1].trim() === '') buf.pop();
  if (buf.length === 0) return;

  let key = `${section}/${caseId}`;
  // Handle the known duplicate `## 10` in Control flow (and any future clashes)
  // by appending a, b, c... to the later occurrence.
  if (written.has(key)) {
    const n = written.get(key) + 1;
    written.set(key, n);
    const suffix = String.fromCharCode('a'.charCodeAt(0) + n);
    const original = `${section}/${caseId}.R`;
    // Rename the first one retroactively to <id>a.R so both get letter suffixes.
    if (n === 1) {
      const firstPath = join(outDir, original);
      const renamed = join(outDir, `${section}/${caseId}a.R`);
      if (existsSync(firstPath)) {
        writeFileSync(renamed, readFileSync(firstPath));
        rmSync(firstPath);
      }
    }
    key = `${section}/${caseId}${suffix}`;
  } else {
    written.set(key, 0);
  }

  const outPath = join(outDir, `${key}.R`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf.join('\n') + '\n');
  buf = [];
}

for (const raw of lines) {
  const sec = raw.match(/^###\s+(.+?)\s*$/);
  if (sec) {
    flush();
    section = slug(sec[1]);
    caseId = null;
    continue;
  }
  const cs = raw.match(/^##\s+(\S+)/);
  if (cs) {
    flush();
    caseId = cs[1];
    continue;
  }
  if (caseId) buf.push(raw);
}
flush();

console.log(`Wrote ${written.size} case groups under ${outDir}`);
