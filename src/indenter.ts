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

/**
 * Internal per-invocation context. Not a user setting — used by the Ctrl+I
 * command path to ask the reindenter "what indent does this blank line want?".
 * The formatter path must leave this undefined so blank lines stay preserved.
 */
export interface ReindentCtx {
  // Line index of a blank/whitespace-only line whose expected indent should be
  // emitted instead of being preserved. All other blank lines are preserved.
  blankIndentFor?: number;
  // Inclusive range of lines to actually reindent. Lines outside this range
  // are preserved verbatim — their bracket stack is still tracked from the
  // original content so later target lines see correct context. When
  // undefined, the entire input is reindented (full-doc behavior).
  targetStart?: number;
  targetEnd?: number;
}

interface BracketToken {
  kind: 'open' | 'close';
  ch: string;
  col: number;
}

interface BracketFrame {
  ch: string;          // ( [ {
  col: number;         // column in the REINDENTED line
  lineIndent: string;  // leading whitespace of the enclosing statement/scope
  hanging: boolean;    // true if opener is the last token on its line → tab-stop mode
  blockHanging: boolean; // true if ( has content after it, but that content ends
                         // with an unmatched open bracket (typically `{`) — after
                         // that block closes, args indent at lineIndent (no +tab).
  lineNo: number;      // index of the line containing this bracket
  prevArgLine?: number;  // most recent arg line of THIS frame (for defer-to-prev).
                         // Only set from lines whose START owner was this frame;
                         // cleared on blank lines (hard boundary).
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPEN_BRACKETS  = new Set(['(', '[', '{']);
const CLOSE_BRACKETS = new Set([')', ']', '}']);
const MATCH_CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const MATCH_OPEN:  Record<string, string> = { '(': ')', '[': ']', '{': '}' };

// Top-level continuation operators — longest first for greedy matching.
// '=' is included so lines ending with e.g. `x =` chain onto the next line.
// Named-arg '=' lives inside brackets, so it never reaches the top-level
// continuation path.
const CONTINUATION_OPS = [
  '&&', '||', '|>', '%>%', ':=', '<-', '->',
  '==', '!=', '<=', '>=',
  '+', '-', '*', '/', '&', '|', '~', '=',
];

// "Major" continuation operators. Each distinct major op appearing in a
// top-level chain opens one extra level of indent for subsequent lines —
// so e.g. `a <- b ~ c := d` nests three levels deep. Operators not in this
// set (+, -, *, /, &&, ||, ...) continue at the current chain level.
// Repetitions of the same op don't stack (a pipe chain `a %>% b %>% c`
// is flat), which is why we count DISTINCT majors rather than occurrences.
// The lookbehind/lookahead around '=' keeps it from matching inside
// ==, !=, <=, >=.
const MAJOR_OPS_RE = /<<-|->>|<-|->|:=|%>%|\|>|~|(?<![<>=!])=(?!=)/g;

// Nesting-major operators: majors that open an additional indent level when
// they appear in a top-level chain. Pipe operators (%>%, |>) are excluded —
// pipe chains stay flat, so `a %>% b` does not nest under a preceding `<-`.
const NESTING_MAJOR_OPS_RE = /<<-|->>|<-|->|:=|~|(?<![<>=!])=(?!=)/g;

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

// Binary operators that can appear at the START of a continuation line
// ("leading operator" style, as in pipe chains or ggplot `+` chains).
// Longest-first for greedy matching. Unary-ambiguous chars (- *) are
// excluded so unary uses don't get shifted.
const LEADING_OPS = [
  '&&', '||', '|>', '%>%', ':=', '<-', '->',
  '==', '!=', '<=', '>=',
  '+', '/', '&', '|', '~',
];

function startsWithLeadingOp(stripped: string): boolean {
  if (!stripped) return false;
  for (const op of LEADING_OPS) {
    if (stripped.startsWith(op)) {
      const after = stripped[op.length];
      if (after === undefined || after === ' ' || after === '\t') return true;
    }
  }
  const pm = PERCENT_OP_RE.exec(stripped);
  if (pm && pm.index === 0) {
    const after = stripped[pm[0].length];
    if (after === undefined || after === ' ' || after === '\t') return true;
  }
  return false;
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

/**
 * True if `line` ends inside an expression where the next thing would
 * naturally be a binary operator — i.e., an unterminated expression term
 * (identifier, literal, closing `)`/`]`), not a comma, not an open bracket,
 * and not an already-dangling operator.
 */
function endsMidExpression(line: string): boolean {
  const cleaned = blankStringsAndComments(line).trimEnd();
  if (!cleaned) return false;
  const last = cleaned[cleaned.length - 1];
  if (last === ',') return false;
  if (OPEN_BRACKETS.has(last)) return false;
  if (lastTokenIsContinuation(line)) return false;
  return true;
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
 * Collect the set of distinct MAJOR_OPS that appear in the chain ending at
 * `prev`. Walks back the same way chainRootIndent does so a chain that
 * closes a multi-line bracketed opener (e.g. `geom_point(...)` across a
 * ggplot chain) still counts the root's majors.
 */
function majorOpsInLine(line: string): Set<string> {
  const cleaned = blankStringsAndComments(line);
  const found = new Set<string>();
  MAJOR_OPS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MAJOR_OPS_RE.exec(cleaned)) !== null) found.add(m[0]);
  return found;
}

function nestingMajorsInLine(line: string): Set<string> {
  const cleaned = blankStringsAndComments(line);
  const found = new Set<string>();
  NESTING_MAJOR_OPS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NESTING_MAJOR_OPS_RE.exec(cleaned)) !== null) found.add(m[0]);
  return found;
}

function majorOpsInChain(
  result: string[],
  prev: number,
  topLevelStarts: Set<number>,
  topLevelContinuations: Set<number>,
): Set<string> {
  const found = new Set<string>();
  let p = prev;
  while (p >= 0) {
    for (const op of majorOpsInLine(result[p])) found.add(op);
    const candidate = prevTopLevel(result, p, topLevelStarts);
    if (candidate < 0) break;
    const pIndent = getLineIndent(result[p]).length;
    const candIndent = getLineIndent(result[candidate]).length;
    if (topLevelContinuations.has(candidate)) {
      p = candidate;
    } else if (candIndent >= pIndent) {
      // Chain-interior line (non-continuation at same-or-greater indent).
      p = candidate;
    } else {
      // Strictly less indent — candidate IS the chain root. Include its
      // majors and continue to add earlier roots if any.
      for (const op of majorOpsInLine(result[candidate])) found.add(op);
      p = candidate;
    }
  }
  return found;
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
export function reindentLines(
  lines: string[],
  opts: ReindentOptions,
  ctx?: ReindentCtx,
): string[] {
  const tab = ' '.repeat(Math.max(1, Math.min(8, opts.tabWidth)));
  const { verticalAlign } = opts;

  const result = [...lines];
  const stack: BracketFrame[] = [];
  const topLevelStarts      = new Set<number>();
  // Last real-line index at each EOL stack depth. Used inside brackets to add
  // an extra tab when the previous line in the same scope ended with a
  // continuation operator. Blank lines clear it (hard boundary); comments
  // pass through unchanged (transparent).
  const prevIdxAtDepth = new Map<number, number>();
  // Index of the root line of an active top-level chain, or -1. A chain opens
  // on the first line that ends at top-level with a continuation op; it stays
  // open across bracketed blocks (e.g. `} %>%`) and closes when a top-level
  // line ends without continuation or a blank line intervenes.
  let chainRootIdx = -1;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const stripped = line.trimStart();

    // Track top-level status before processing this line's tokens
    if (stack.length === 0) topLevelStarts.add(idx);

    // Capture the frame that owned us at the START of the line, before any
    // bracket tokens on this line change the stack. This frame is where we
    // record prevArgLine for defer-to-prev logic on subsequent lines.
    const startOwner = stack.length > 0 ? stack[stack.length - 1] : null;

    // ── Compute desired indent ───────────────────────────────────────────────
    let newLine: string;

    // A blank line targeted by ctx.blankIndentFor falls through to the indent
    // computation so the emitted line is the expected indent string.
    const isTargetBlank = stripped === '' && ctx?.blankIndentFor === idx;

    // Lines outside the caller's target range are preserved verbatim. We still
    // tokenize them below so the bracket stack is correct for later target
    // lines; the general rule is that target lines defer to the indentation
    // already on the page. targetBlank trumps targetRange.
    const targetStart = ctx?.targetStart;
    const targetEnd   = ctx?.targetEnd ?? targetStart;
    const inTargetRange = targetStart === undefined
      || (idx >= targetStart && idx <= (targetEnd as number));

    if (!isTargetBlank && (idx === 0 || stripped === '')) {
      newLine = line;

    } else if (!isTargetBlank && !inTargetRange) {
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
        // Leading-operator style: when a continuation line inside `(` starts
        // with a binary operator (|>, +, ~, …), ESS shifts it one column past
        // the vertical-align position so the operator visually sits left of
        // the aligned argument content. A blank Ctrl+I target gets the same
        // shift when the prior same-depth line ended mid-expression — the
        // user is about to type an operator, so place the cursor where it
        // would go (e.g. after `(foo`, cursor sits on the first `o`).
        const prevSameDepthForShift = prevIdxAtDepth.get(stack.length);
        const blankExpectsOp =
          isTargetBlank &&
          prevSameDepthForShift !== undefined &&
          endsMidExpression(result[prevSameDepthForShift]);
        const leadingOpShift =
          (startsWithLeadingOp(stripped) || blankExpectsOp) &&
          verticalAlign && owner.ch === '(' && !owner.hanging
            ? 1 : 0;

        if (owner.ch === '(' && owner.blockHanging) {
          // `(` whose line ends inside an open block: after the block closes,
          // subsequent args sit at the paren's lineIndent (no +tab).
          desired = owner.lineIndent;
        } else if (owner.ch === '(' && owner.hanging && stripped[0] === '{') {
          // Lone `{` as a standalone argument inside a hanging `(`: the block
          // anchors at the paren's lineIndent, not one tab deeper.
          desired = owner.lineIndent;
        } else if (idx - 1 === owner.lineNo) {
          desired = (verticalAlign && owner.ch === '(' && !owner.hanging)
            ? ' '.repeat(owner.col + 1 + leadingOpShift)
            : owner.lineIndent + tab;
        } else if (owner.ch === '(') {
          desired = (verticalAlign && !owner.hanging)
            ? ' '.repeat(owner.col + 1 + leadingOpShift)
            : owner.lineIndent + tab;
        } else {
          desired = (verticalAlign && owner.ch !== '{' && !owner.hanging)
            ? ' '.repeat(owner.col + 1 + leadingOpShift)
            : owner.lineIndent + tab;
        }

        // Extra tab when the previous non-blank line at this depth ended
        // with a continuation operator.
        const prevSameDepth = prevIdxAtDepth.get(stack.length);
        if (prevSameDepth !== undefined && lastTokenIsContinuation(result[prevSameDepth])) {
          desired += tab;
        }

        // Defer to the previous arg line of this same bracket frame WHEN that
        // line is outside the caller's target range — i.e. user content we
        // were asked not to touch. In that case the user's chosen indent is
        // authoritative and a later target arg should align with it rather
        // than the algorithmic default. Adjust for leading-op shift so non-op
        // and op-led args still line up.
        const prevArg = owner.prevArgLine;
        if (prevArg !== undefined && targetStart !== undefined
            && (prevArg < targetStart || prevArg > (targetEnd as number))) {
          const prevLine = result[prevArg];
          const prevCol  = getLineIndent(prevLine).length;
          const isVA = verticalAlign && owner.ch === '(' && !owner.hanging;
          const prevOp = isVA && startsWithLeadingOp(prevLine.trimStart()) ? 1 : 0;
          const curOp  = isVA && startsWithLeadingOp(stripped) ? 1 : 0;
          desired = ' '.repeat(Math.max(0, prevCol - prevOp + curOp));
        }

      // Top-level line
      } else {
        // Walk back to the nearest real line (skip comments, stop at blank).
        let prevReal = idx - 1;
        while (prevReal >= 0) {
          const s = result[prevReal].trim();
          if (s === '') { prevReal = -1; break; }
          if (s.startsWith('#')) { prevReal--; continue; }
          break;
        }

        if (chainRootIdx >= 0 && prevReal >= 0 && lastTokenIsContinuation(result[prevReal])) {
          // Continuation of an active chain. Base indent is one tab deeper
          // than the chain root; each distinct NESTING-major op that has
          // appeared in the chain so far adds another tab.
          const rootIndent = getLineIndent(result[chainRootIdx]);
          const seen = new Set<string>();
          for (let i = chainRootIdx; i < idx; i++) {
            for (const op of nestingMajorsInLine(result[i])) seen.add(op);
          }
          const levels = Math.max(1, seen.size);
          desired = rootIndent + tab.repeat(levels);
        } else if (stripped[0] === '{' && prevReal >= 0) {
          // Block body of the preceding statement (e.g. `function()` on one
          // line, `{` on the next). Inherit the preceding line's indent.
          desired = getLineIndent(result[prevReal]);
        } else {
          desired = '';
        }
      }

      newLine = desired + stripped;
    }

    result[idx] = newLine;

    // ── Update bracket stack from the REINDENTED line ────────────────────────
    const newIndent = getLineIndent(newLine);
    const newLineCleaned = blankStringsAndComments(newLine);
    // Tracks the most recent `(` popped on this line: when a `{` is pushed
    // immediately after, the `{` is the body of that parenthesised construct
    // (e.g. `function(args) {`) and should anchor its lineIndent to that
    // construct's line, not to its own column.
    let lastPoppedParenLineIndent: string | null = null;
    for (const tok of tokenizeLine(newLine)) {
      if (tok.kind === 'open') {
        const remainder = newLineCleaned.slice(tok.col + 1);
        const hanging = remainder.trim() === '';
        const trimmed = remainder.trimEnd();
        const lastChar = trimmed.length > 0 ? trimmed[trimmed.length - 1] : '';
        const blockHanging = tok.ch === '(' && !hanging && OPEN_BRACKETS.has(lastChar);

        // `{` anchors to the enclosing statement:
        //  - if a `)` was just popped on this line, use that paren's lineIndent
        //    (`function(args) {` — the `{` is the body of that call);
        //  - otherwise stay at the current line's indent.
        let lineIndent = newIndent;
        if (tok.ch === '{' && lastPoppedParenLineIndent !== null) {
          lineIndent = lastPoppedParenLineIndent;
        }

        stack.push({ ch: tok.ch, col: tok.col, lineIndent, hanging, blockHanging, lineNo: idx });
      } else {
        const expected = MATCH_CLOSE[tok.ch];
        if (stack.length > 0 && stack[stack.length - 1].ch === expected) {
          const popped = stack.pop()!;
          if (popped.ch === '(') lastPoppedParenLineIndent = popped.lineIndent;
        }
      }
    }

    // Update per-depth tracker. Blank line = hard boundary; comment = transparent.
    if (stripped === '') {
      prevIdxAtDepth.clear();
      // Blank lines also reset every frame's defer anchor — a blank line is
      // a hard continuation boundary, so a later arg should re-align against
      // the opener rather than inheriting some pre-blank sibling's indent.
      for (const f of stack) f.prevArgLine = undefined;
    } else if (!stripped.startsWith('#')) {
      prevIdxAtDepth.set(stack.length, idx);
      // Record this line as the previous-arg of the frame that owned us when
      // the line began. Lines starting at top level have no owner. Comments
      // are transparent and skipped.
      if (startOwner !== null) startOwner.prevArgLine = idx;
    }

    // Update top-level chain tracking. Blank lines break the chain; comments
    // are transparent; lines ending inside brackets preserve the chain so it
    // can resume when the block closes.
    if (stripped === '') {
      chainRootIdx = -1;
    } else if (!stripped.startsWith('#') && stack.length === 0) {
      if (lastTokenIsContinuation(newLine)) {
        if (chainRootIdx === -1) chainRootIdx = idx;
      } else {
        chainRootIdx = -1;
      }
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
export function reindentRmdChunks(
  lines: string[],
  opts: ReindentOptions,
  ctx?: ReindentCtx,
): string[] {
  const result = [...lines];
  const blankTarget = ctx?.blankIndentFor;
  const tStart = ctx?.targetStart;
  const tEnd   = ctx?.targetEnd ?? tStart;
  for (const [start, end] of extractRRanges(lines)) {
    const chunk = lines.slice(start, end + 1);
    const chunkCtx: ReindentCtx = {};
    if (blankTarget !== undefined && blankTarget >= start && blankTarget <= end) {
      chunkCtx.blankIndentFor = blankTarget - start;
    }
    if (tStart !== undefined) {
      // Intersect the caller's target range with this chunk, clipped to
      // chunk-relative indices. If they don't overlap, skip reindent entirely
      // for this chunk by passing an empty range.
      const lo = Math.max(tStart, start);
      const hi = Math.min(tEnd as number, end);
      if (lo > hi) {
        chunkCtx.targetStart = 0;
        chunkCtx.targetEnd   = -1;
      } else {
        chunkCtx.targetStart = lo - start;
        chunkCtx.targetEnd   = hi - start;
      }
    }
    const reindented = reindentLines(chunk, opts, chunkCtx);
    result.splice(start, end - start + 1, ...reindented);
  }
  return result;
}
