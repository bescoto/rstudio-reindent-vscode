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

// State tracking strings that span lines. `null` means we're in normal code.
// Backticks are not tracked across lines (R doesn't allow multi-line backtick
// identifiers), but regular and raw strings can.
type StringState =
  | null
  | { kind: 'str'; quote: string }
  | { kind: 'raw'; quote: string; close: string };

interface LineScan {
  tokens: BracketToken[];
  cleaned: string;
  exitState: StringState;
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
 * Scan a single R source line, optionally resuming an open multi-line string
 * from the previous line. Returns:
 *   tokens    — bracket tokens outside strings/comments
 *   cleaned   — copy of `line` with string contents and `#` comments replaced
 *               by spaces (column-preserving), for safe operator detection
 *   exitState — non-null if a string is still open at end of line
 */
function scanLine(line: string, entryState: StringState = null): LineScan {
  const chars = line.split('');
  const n = chars.length;
  const tokens: BracketToken[] = [];
  let i = 0;
  let state: StringState = entryState;

  // Resume scanning inside a string carried over from the prior line.
  if (state !== null) {
    if (state.kind === 'str') {
      const q = state.quote;
      while (i < n) {
        const c = chars[i];
        if (c === '\\') {
          chars[i] = ' ';
          if (i + 1 < n) chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === q) { chars[i] = ' '; i++; state = null; break; }
        chars[i] = ' ';
        i++;
      }
    } else {
      const q = state.quote;
      const close = state.close;
      while (i < n) {
        if (chars[i] === close) {
          let j = i + 1;
          while (j < n && chars[j] === '-') j++;
          if (j < n && chars[j] === q) {
            for (let k = i; k <= j; k++) chars[k] = ' ';
            i = j + 1;
            state = null;
            break;
          }
        }
        chars[i] = ' ';
        i++;
      }
    }
    if (state !== null) {
      return { tokens, cleaned: chars.join(''), exitState: state };
    }
  }

  while (i < n) {
    const ch = chars[i];

    if (ch === '#') {
      for (let j = i; j < n; j++) chars[j] = ' ';
      break;
    }

    // R raw strings: r"(...)"  r'[...]'  R"{...}"  r"--[...]--"  etc.
    if ((ch === 'r' || ch === 'R') && i + 1 < n && (chars[i + 1] === '"' || chars[i + 1] === "'")) {
      const q = chars[i + 1];
      let j = i + 2;
      while (j < n && chars[j] === '-') j++;
      if (j < n && OPEN_BRACKETS.has(chars[j])) {
        const closeDelim = MATCH_OPEN[chars[j]];
        j++;
        let found = false;
        while (j < n) {
          if (chars[j] === closeDelim) {
            let k = j + 1;
            while (k < n && chars[k] === '-') k++;
            if (k < n && chars[k] === q) {
              for (let m = i; m <= k; m++) chars[m] = ' ';
              j = k + 1;
              found = true;
              break;
            }
          }
          j++;
        }
        if (!found) {
          for (let m = i; m < n; m++) chars[m] = ' ';
          state = { kind: 'raw', quote: q, close: closeDelim };
          i = n;
        } else {
          i = j;
        }
        continue;
      }
      // `r` / `R` not followed by a raw-string opener — treat as ordinary char.
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      let j = i + 1;
      let terminated = false;
      while (j < n) {
        if (chars[j] === '\\') { j += 2; continue; }
        if (chars[j] === q)   { j++; terminated = true; break; }
        j++;
      }
      const end = Math.min(j, n);
      for (let k = i; k < end; k++) chars[k] = ' ';
      if (!terminated && q !== '`') {
        // Backticks don't span lines in R; only `"` and `'` carry over.
        state = { kind: 'str', quote: q };
      }
      i = end;
      continue;
    }

    if (OPEN_BRACKETS.has(ch))  { tokens.push({ kind: 'open',  ch, col: i }); i++; continue; }
    if (CLOSE_BRACKETS.has(ch)) { tokens.push({ kind: 'close', ch, col: i }); i++; continue; }

    i++;
  }

  return { tokens, cleaned: chars.join(''), exitState: state };
}

function tokenizeLine(line: string): BracketToken[] {
  return scanLine(line, null).tokens;
}

function blankStringsAndComments(line: string): string {
  return scanLine(line, null).cleaned;
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

/**
 * True if `line` is a control-flow opener whose body is expected on the
 * following line — i.e., `if/for/while (...)`, `else`, `else if (...)`, or
 * `repeat`, with no body on the same line. The next non-blank line is then
 * the implicit body and should be indented one tab deeper than `line`.
 *
 * This only fires when the statement's `(...)` has actually closed on this
 * line (bracket-balanced), so partial openers like `if (x &&` don't qualify.
 */
function endsControlOpener(line: string): boolean {
  const cleaned = blankStringsAndComments(line).trimEnd();
  if (!cleaned) return false;

  if (cleaned.endsWith(')')) {
    // Find the matching `(` by scanning backwards with a depth counter.
    let depth = 0;
    let i = cleaned.length - 1;
    for (; i >= 0; i--) {
      const c = cleaned[i];
      if (c === ')') depth++;
      else if (c === '(') { depth--; if (depth === 0) break; }
    }
    if (i < 0) return false;
    const before = cleaned.slice(0, i).trimEnd();
    return /\b(if|for|while)$/.test(before);
  }

  return /(?:^|[^\w.])(?:else|repeat)$/.test(cleaned);
}

/**
 * True if `line` ends with a bracket-balanced `function(...)` with nothing
 * after it — a function declaration whose body must live on a subsequent
 * line. Unlike `endsControlOpener`, this relationship survives blank lines
 * because `function()` alone is syntactically incomplete and R's parser
 * keeps looking for a body regardless of intervening blanks.
 */
function endsIncompleteFunction(line: string): boolean {
  const cleaned = blankStringsAndComments(line).trimEnd();
  if (!cleaned || !cleaned.endsWith(')')) return false;
  let depth = 0;
  let i = cleaned.length - 1;
  for (; i >= 0; i--) {
    const c = cleaned[i];
    if (c === ')') depth++;
    else if (c === '(') { depth--; if (depth === 0) break; }
  }
  if (i < 0) return false;
  const before = cleaned.slice(0, i).trimEnd();
  return /\bfunction$/.test(before);
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
  // Per-depth chain roots for continuation chains inside brackets. Consulted
  // when indenting lines inside a blockHanging `(`, where args sit at the
  // paren's lineIndent and a nested-major chain (e.g. `= ... ~ ...`) should
  // open additional indent levels just like at top level.
  const chainRootAtDepth = new Map<number, number>();
  // Multi-line string state carried from the prior line. When non-null at the
  // start of a line, the line BEGINS inside an open string literal — its
  // leading whitespace is part of the string contents and must be preserved.
  let stringState: StringState = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const stripped = line.trimStart();
    const entryState = stringState;
    const inString = entryState !== null;

    // Track top-level status before processing this line's tokens. A line
    // that begins inside a string is content of the previous statement, not
    // a new top-level start.
    if (stack.length === 0 && !inString) topLevelStarts.add(idx);

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

    if (inString) {
      // Line begins inside an unterminated string from a prior line — leading
      // whitespace is string content, leave it untouched.
      newLine = line;

    } else if (!isTargetBlank && (idx === 0 || stripped === '')) {
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
        // Leading-operator style: a continuation line inside `(` that starts
        // with a binary operator (|>, +, ~, …) follows the ENCLOSING scope's
        // indent (one tab past the opener's lineIndent), not the column of
        // the paren — ESS/RStudio treat leading operators as belonging to
        // the outer scope rather than the call expression. Blank Ctrl+I
        // targets get the same treatment when the prior same-depth line
        // ended mid-expression (user is about to type an operator).
        const prevSameDepthForShift = prevIdxAtDepth.get(stack.length);
        const blankExpectsOp =
          isTargetBlank &&
          prevSameDepthForShift !== undefined &&
          endsMidExpression(result[prevSameDepthForShift]);
        const useLeadingOpIndent =
          (startsWithLeadingOp(stripped) || blankExpectsOp) &&
          verticalAlign && owner.ch === '(' && !owner.hanging;

        if (owner.ch === '(' && owner.blockHanging) {
          // `(` whose line ends inside an open block: after the block closes,
          // subsequent args sit at the paren's lineIndent (no +tab).
          desired = owner.lineIndent;
        } else if (owner.ch === '(' && owner.hanging && stripped[0] === '{') {
          // Lone `{` as a standalone argument inside a hanging `(`: the block
          // anchors at the paren's lineIndent, not one tab deeper.
          desired = owner.lineIndent;
        } else if (useLeadingOpIndent) {
          desired = owner.lineIndent + tab;
        } else if (idx - 1 === owner.lineNo) {
          desired = (verticalAlign && owner.ch === '(' && !owner.hanging)
            ? ' '.repeat(owner.col + 1)
            : owner.lineIndent + tab;
        } else if (owner.ch === '(') {
          desired = (verticalAlign && !owner.hanging)
            ? ' '.repeat(owner.col + 1)
            : owner.lineIndent + tab;
        } else {
          // `[` and `{` both use tab-stop — no vertical alignment.
          // This keeps continuation lines inside `[` from staircasing past
          // the first inner line (which also uses tab-stop via the
          // `idx - 1 === owner.lineNo` branch above).
          desired = owner.lineIndent + tab;
        }

        // Extra tab when the previous non-blank line at this depth ended
        // with a continuation operator. Inside a blockHanging `(` the chain
        // acts like a top-level chain: each distinct nesting-major op in
        // the chain opens another indent level.
        const prevSameDepth = prevIdxAtDepth.get(stack.length);
        if (prevSameDepth !== undefined && lastTokenIsContinuation(result[prevSameDepth])) {
          const chainRoot = chainRootAtDepth.get(stack.length);
          if (owner.ch === '(' && owner.blockHanging
              && chainRoot !== undefined && chainRoot < idx) {
            const seen = new Set<string>();
            for (let i = chainRoot; i < idx; i++) {
              for (const op of nestingMajorsInLine(result[i])) seen.add(op);
            }
            desired += tab.repeat(Math.max(1, seen.size));
          } else {
            desired += tab;
          }
        }

        // Previous line was a control-flow opener without a body brace
        // (`if (cond)`, `else`, `else if (cond)`, `for (...)`, `while (...)`,
        // `repeat`): the current line is the implicit body and sits one tab
        // deeper than that opener. Skipped when the current line starts with
        // `{` — a body brace aligns with the opener, it doesn't nest further.
        if (owner.ch === '{' && stripped[0] !== '{') {
          const prevOpener = prevIdxAtDepth.get(stack.length);
          if (prevOpener !== undefined && endsControlOpener(result[prevOpener])) {
            desired = getLineIndent(result[prevOpener]) + tab;
          }
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
        } else if (prevReal >= 0 && endsControlOpener(result[prevReal])) {
          // Implicit body of a one-line `if/for/while/else/repeat`.
          desired = getLineIndent(result[prevReal]) + tab;
        } else {
          // `function(...)` with no body on its line is syntactically
          // incomplete — the next non-blank non-comment line is the body,
          // even across blank lines. Walk back past blanks/comments looking
          // for such an opener.
          let prevAny = idx - 1;
          while (prevAny >= 0) {
            const s = result[prevAny].trim();
            if (s === '' || s.startsWith('#')) { prevAny--; continue; }
            break;
          }
          if (prevAny >= 0 && endsIncompleteFunction(result[prevAny])) {
            desired = getLineIndent(result[prevAny]) + tab;
          } else {
            desired = '';
          }
        }
      }

      newLine = desired + stripped;
    }

    result[idx] = newLine;

    // ── Update bracket stack from the REINDENTED line ────────────────────────
    const newIndent = getLineIndent(newLine);
    const scan = scanLine(newLine, entryState);
    const newLineCleaned = scan.cleaned;
    stringState = scan.exitState;
    // Tracks the most recent `(` popped on this line: when a `{` is pushed
    // immediately after, the `{` is the body of that parenthesised construct
    // (e.g. `function(args) {`) and should anchor its lineIndent to that
    // construct's line, not to its own column.
    let lastPoppedParenLineIndent: string | null = null;
    for (const tok of scan.tokens) {
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

    // Update per-depth tracker. Blank line = hard boundary; comment = transparent;
    // lines that begin inside a multi-line string are content of the prior
    // statement, so they don't update arg-tracking either.
    if (stripped === '') {
      prevIdxAtDepth.clear();
      // Blank lines also reset every frame's defer anchor — a blank line is
      // a hard continuation boundary, so a later arg should re-align against
      // the opener rather than inheriting some pre-blank sibling's indent.
      for (const f of stack) f.prevArgLine = undefined;
    } else if (!stripped.startsWith('#') && !inString) {
      prevIdxAtDepth.set(stack.length, idx);
      // Record this line as the previous-arg of the frame that owned us when
      // the line began. Lines starting at top level have no owner. Comments
      // are transparent and skipped.
      if (startOwner !== null) startOwner.prevArgLine = idx;
    }

    // Update top-level chain tracking. Blank lines break the chain; comments
    // and in-string continuations are transparent; lines ending inside
    // brackets preserve the chain so it can resume when the block closes.
    if (stripped === '') {
      chainRootIdx = -1;
      chainRootAtDepth.clear();
    } else if (!stripped.startsWith('#') && !inString) {
      // A chain opens at the FIRST line involving top level that ends with a
      // continuation operator — either a line that also ENDS at top level
      // (classic `a %>%` → next line continues), OR a line that STARTS at
      // top level but dives into a bracket (e.g. `x[a %>%` opens a pipe
      // chain rooted at the `x[...` line itself). The start-of-line case
      // keeps the chain root anchored before the bracket so when the chain
      // re-emerges (`] %>%` → tail), the tail indents off the outermost
      // root rather than off the re-emerging line.
      const startedAtTop = startOwner === null;
      const endAtTop     = stack.length === 0;
      const endsCont     = lastTokenIsContinuation(newLine);
      if (endsCont && (startedAtTop || endAtTop)) {
        if (chainRootIdx === -1) chainRootIdx = idx;
      } else if (endAtTop && !endsCont) {
        chainRootIdx = -1;
      }
      // Per-depth chain tracking at end-of-line depth. Only the current
      // depth's chain state is touched; chains at outer depths persist
      // across intervening nested-bracket lines.
      const endDepth = stack.length;
      if (lastTokenIsContinuation(newLine)) {
        if (!chainRootAtDepth.has(endDepth)) chainRootAtDepth.set(endDepth, idx);
      } else {
        chainRootAtDepth.delete(endDepth);
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
