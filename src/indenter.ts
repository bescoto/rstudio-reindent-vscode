/**
 * indenter.ts
 *
 * TypeScript port of the RStudio-style vertical argument alignment algorithm
 * developed in reindent.py. The logic is identical; only the surface syntax
 * changes from Python to TypeScript.
 *
 * Public API:
 *   reindentLines(lines, opts)  — reindent an array of R source lines
 *   reindentRmdChunks(lines, opts) — reindent only the R blocks in a .qmd/.Rmd
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReindentOptions {
  verticalAlign: boolean; // true  → align to col after opening bracket
  tabWidth: number;       // spaces per indent level
}

interface BracketToken {
  kind: 'open' | 'close';
  ch: string;
  col: number;
}

interface BracketFrame {
  ch: string;          // ( [ {
  col: number;         // column in the REINDENTED line
  lineIndent: string;  // leading whitespace of the line containing this bracket
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPEN_BRACKETS  = new Set(['(', '[', '{']);
const CLOSE_BRACKETS = new Set([')', ']', '}']);
const MATCH_CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const MATCH_OPEN:  Record<string, string> = { '(': ')', '[': ']', '{': '}' };

// Top-level continuation operators — longest first for greedy matching.
// Note: bare '=' intentionally excluded (named args handled by bracket context).
const CONTINUATION_OPS = [
  '&&', '||', '|>', '%>%', ':=', '<-', '->',
  '==', '!=', '<=', '>=',
  '+', '-', '*', '/', '&', '|', '~',
];

// } else { and } else if (...) {
const ELSE_RE = /^\s*\}\s*else(\s+if\s*\(.*\))?\s*\{?\s*$/;

// %op% operators like %in%, %between%
const PERCENT_OP_RE = /%[^%\n]+%/;

// Opening fence for R code blocks in .qmd / .Rmd
const RMD_FENCE_OPEN  = /^```\{[Rr](\s|,|\})/;
const RMD_FENCE_CLOSE = /^```\s*$/;


// ─── Tokenizer ────────────────────────────────────────────────────────────────

/**
 * Scan a single R source line and return an array of bracket tokens.
 * Strings (regular, raw, backtick) and # comments are consumed and skipped
 * so brackets inside them are invisible to the indenter.
 */
function tokenizeLine(line: string): BracketToken[] {
  const tokens: BracketToken[] = [];
  const n = line.length;
  let i = 0;

  while (i < n) {
    const ch = line[i];

    // Line comment
    if (ch === '#') break;

    // R raw strings: r"(...)"  r'[...]'  R"{...}"  etc.
    if ((ch === 'r' || ch === 'R') && i + 1 < n && (line[i + 1] === '"' || line[i + 1] === "'")) {
      const q = line[i + 1];
      let j = i + 2;
      while (j < n && line[j] === '-') j++;
      if (j < n && OPEN_BRACKETS.has(line[j])) {
        const closeDelim = MATCH_OPEN[line[j]];
        j++;
        while (j < n && line[j] !== closeDelim) j++;
        while (j < n && line[j] !== q) j++;
      }
      i = j + 1;
      continue;
    }

    // Regular string literals: " ' `
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line[j] === ch)   { j++;    break; }
        j++;
      }
      i = j;
      continue;
    }

    if (OPEN_BRACKETS.has(ch))  { tokens.push({ kind: 'open',  ch, col: i }); i++; continue; }
    if (CLOSE_BRACKETS.has(ch)) { tokens.push({ kind: 'close', ch, col: i }); i++; continue; }

    i++;
  }

  return tokens;
}

/**
 * Return a copy of `line` with string contents and # comments replaced by
 * spaces, preserving column positions, for safe operator detection.
 */
function blankStringsAndComments(line: string): string {
  const chars = line.split('');
  const n = chars.length;
  let i = 0;

  while (i < n) {
    const ch = chars[i];

    if (ch === '#') {
      for (let j = i; j < n; j++) chars[j] = ' ';
      break;
    }

    if ((ch === 'r' || ch === 'R') && i + 1 < n && (chars[i + 1] === '"' || chars[i + 1] === "'")) {
      const q = chars[i + 1];
      let j = i + 2;
      while (j < n && chars[j] === '-') j++;
      if (j < n && OPEN_BRACKETS.has(chars[j])) {
        const closeDelim = MATCH_OPEN[chars[j]];
        j++;
        while (j < n && chars[j] !== closeDelim) j++;
        while (j < n && chars[j] !== q) j++;
      }
      for (let k = i; k <= Math.min(j, n - 1); k++) chars[k] = ' ';
      i = j + 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (chars[j] === '\\') { j += 2; continue; }
        if (chars[j] === ch)   { j++;    break; }
        j++;
      }
      for (let k = i; k < Math.min(j, n); k++) chars[k] = ' ';
      i = j;
      continue;
    }

    i++;
  }

  return chars.join('');
}


// ─── Continuation detection ───────────────────────────────────────────────────

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t === '' || t.startsWith('#');
}

function lastTokenIsContinuation(line: string): boolean {
  const cleaned = blankStringsAndComments(line).trimEnd();
  if (!cleaned) return false;

  const last = cleaned[cleaned.length - 1];
  if (CLOSE_BRACKETS.has(last) || last === ',') return false;

  for (const op of CONTINUATION_OPS) {
    if (cleaned.endsWith(op)) return true;
  }

  const pm = PERCENT_OP_RE.exec(cleaned);
  if (pm && cleaned.endsWith('%')) return true;

  return false;
}


// ─── Utility ──────────────────────────────────────────────────────────────────

function getLineIndent(line: string): string {
  return line.match(/^(\s*)/)?.[1] ?? '';
}

/**
 * Scan backwards from `before - 1`, returning the nearest index that is in
 * topLevelStarts and is not blank and not a pure comment line.
 * A blank line is a hard stop — returns -1 immediately.
 */
function prevTopLevel(
  result: string[],
  before: number,
  topLevelStarts: Set<number>,
): number {
  let p = before - 1;
  while (p >= 0) {
    const line = result[p];
    if (line.trim() === '') return -1;          // blank = hard boundary
    if (isCommentLine(line)) { p--; continue; } // comment = transparent
    if (topLevelStarts.has(p)) return p;
    p--;
  }
  return -1;
}

/**
 * Walk back through consecutive top-level continuations to find the root
 * of the chain (the line not itself preceded by a continuation).
 * Returns the indent of that root line.
 */
function chainRootIndent(
  result: string[],
  start: number,
  topLevelStarts: Set<number>,
  topLevelContinuations: Set<number>,
): string {
  // Walk backwards to find the true root of the chain.
  // Continue past chain-interior openers (same/deeper indent than current root)
  // as well as explicit continuation lines, stopping only when we find a line
  // with strictly less indent — that is the actual chain root.
  let root = start;
  let rootIndent = getLineIndent(result[root]);
  while (true) {
    const candidate = prevTopLevel(result, root, topLevelStarts);
    if (candidate < 0) break;
    const candidateIndent = getLineIndent(result[candidate]);
    if (topLevelContinuations.has(candidate)) {
      root = candidate; rootIndent = candidateIndent;
    } else if (candidateIndent.length >= rootIndent.length) {
      // Chain-interior opener (e.g. geom_point( spanning multiple lines)
      root = candidate; rootIndent = candidateIndent;
    } else {
      // Strictly less indent — this IS the chain root
      root = candidate; rootIndent = candidateIndent;
      break;
    }
  }
  return rootIndent;
}


// ─── Core streaming reindenter ────────────────────────────────────────────────

/**
 * Reindent an array of R source lines using a streaming single-pass approach:
 * for each line, compute its indent, apply it, then tokenize the reindented
 * line so bracket column positions are correct for all subsequent lines.
 *
 * Blank lines are preserved unchanged.
 */
export function reindentLines(lines: string[], opts: ReindentOptions): string[] {
  const tab = ' '.repeat(Math.max(1, Math.min(8, opts.tabWidth)));
  const { verticalAlign } = opts;

  const result = [...lines];
  const stack: BracketFrame[] = [];
  const topLevelStarts      = new Set<number>();
  const topLevelContinuations = new Set<number>();

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const stripped = line.trimStart();

    // Track top-level status before processing this line's tokens
    if (stack.length === 0) topLevelStarts.add(idx);

    // ── Compute desired indent ───────────────────────────────────────────────
    let newLine: string;

    if (idx === 0 || stripped === '') {
      newLine = line;

    } else {
      const owner = stack.length > 0 ? stack[stack.length - 1] : null;
      let desired: string;

      // } else { / } else if — align to opener's line indent (both branches)
      if (ELSE_RE.test(line) && owner !== null) {
        desired = owner.lineIndent;

      // Plain closing bracket — dedent to opener's line indent
      } else if (CLOSE_BRACKETS.has(stripped[0])) {
        desired = owner?.lineIndent ?? '';

      // Inside a bracket — vertical align or tab-stop
      } else if (owner !== null) {
        desired = (verticalAlign && owner.ch !== '{')
          ? ' '.repeat(owner.col + 1)
          : owner.lineIndent + tab;

      // Top-level line
      } else {
        const prev = prevTopLevel(result, idx, topLevelStarts);

        if (prev < 0) {
          desired = '';
        } else if (topLevelContinuations.has(prev)) {
          // Part of a pipe/ggplot chain — all steps share root_indent + tab
          desired = chainRootIndent(result, prev, topLevelStarts, topLevelContinuations) + tab;
        } else {
          desired = getLineIndent(result[prev]);
        }
      }

      newLine = desired + stripped;
    }

    result[idx] = newLine;

    // ── Update bracket stack from the REINDENTED line ────────────────────────
    const newIndent = getLineIndent(newLine);
    for (const tok of tokenizeLine(newLine)) {
      if (tok.kind === 'open') {
        stack.push({ ch: tok.ch, col: tok.col, lineIndent: newIndent });
      } else {
        const expected = MATCH_CLOSE[tok.ch];
        if (stack.length > 0 && stack[stack.length - 1].ch === expected) {
          stack.pop();
        }
      }
    }

    // Record top-level continuation after stack update (needs EOL stack state)
    if (stack.length === 0 && topLevelStarts.has(idx) && lastTokenIsContinuation(newLine)) {
      topLevelContinuations.add(idx);
    }
  }

  return result;
}


// ─── .qmd / .Rmd fence handling ───────────────────────────────────────────────

/** Extract [start, end] ranges (inclusive) of R code blocks in a .qmd/.Rmd */
function extractRRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let inside = false;
  let start = 0;

  for (let i = 0; i < lines.length; i++) {
    if (!inside && RMD_FENCE_OPEN.test(lines[i])) {
      inside = true;
      start = i + 1;
    } else if (inside && RMD_FENCE_CLOSE.test(lines[i])) {
      if (start <= i - 1) ranges.push([start, i - 1]);
      inside = false;
    }
  }

  return ranges;
}

/**
 * Reindent only the R code blocks in a .qmd or .Rmd file.
 * Each block gets its own fresh bracket stack.
 * Prose and non-R fences are untouched.
 */
export function reindentRmdChunks(lines: string[], opts: ReindentOptions): string[] {
  const result = [...lines];
  for (const [start, end] of extractRRanges(lines)) {
    const chunk = lines.slice(start, end + 1);
    const reindented = reindentLines(chunk, opts);
    result.splice(start, end - start + 1, ...reindented);
  }
  return result;
}
