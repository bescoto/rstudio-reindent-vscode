/**
 * extension.ts — R Reindent Lines VSCode extension
 *
 * Registers:
 *   • Command "R: Reindent Lines"  (palette + context menu + keybinding)
 *   • DocumentRangeFormattingEditProvider for R / Quarto / RMarkdown
 *
 * The command operates on the current selection, or the current line if
 * nothing is selected.
 *
 * The formatting provider integrates with VSCode's built-in format-selection
 * (Ctrl+K Ctrl+F / Shift+Alt+F) so the extension also participates in the
 * standard formatting pipeline.
 */

import * as vscode from 'vscode';
import { reindentLines, reindentRmdChunks, ReindentOptions, ReindentCtx } from './indenter';
import { adjustCursorAfterReindent } from './cursor';

// Language IDs recognised by VSCode for R-family files.
// 'r'      — base R language support (e.g. REditorSupport.r extension)
// 'rmd'    — R Markdown (some extensions use this)
// 'quarto' — Quarto (quarto.quarto extension)
const R_LANG_IDS = new Set(['r', 'rmd', 'quarto']);
const RMD_LANG_IDS = new Set(['rmd', 'quarto']);

const LANG_SELECTOR: vscode.DocumentSelector = [
  { language: 'r' },
  { language: 'rmd' },
  { language: 'quarto' },
];


// ─── Read user settings ───────────────────────────────────────────────────────

function getOptions(): ReindentOptions {
  const cfg = vscode.workspace.getConfiguration('r-reindent');
  return {
    verticalAlign: cfg.get<boolean>('verticalAlign', true),
    tabWidth:      cfg.get<number>('tabWidth', 2),
  };
}


// ─── Core reindent logic ──────────────────────────────────────────────────────

/**
 * Compute TextEdits that reindent `range` (full lines) inside `document`.
 *
 * For .qmd/.Rmd: delegates to reindentRmdChunks so only R code blocks are
 * touched. For plain .R files: all lines in range are processed.
 *
 * Returns an array of TextEdits (one per changed line) suitable for both the
 * command handler and the formatting provider.
 */
function computeEdits(
  document: vscode.TextDocument,
  range: vscode.Range,
  opts: ReindentOptions,
  ctx?: ReindentCtx,
): { edits: vscode.TextEdit[], reindented: string[] } {
  const startLine = range.start.line;
  const endLine   = range.end.line;

  // Collect the lines we'll work on.
  // For the reindenter to compute correct context, we always pass lines from
  // the TOP of the document (or top of the R chunk for .qmd/.Rmd) to the end
  // of the selection. The algorithm needs prior lines to determine indent.
  const allLines: string[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    allLines.push(document.lineAt(i).text);
  }

  const isRmd = RMD_LANG_IDS.has(document.languageId);

  // Reindent the full document (or all chunks) so context is correct. Lines
  // outside the caller's range are fed to the reindenter for stack tracking
  // but left untouched; target lines defer to those existing indents.
  const rangedCtx: ReindentCtx = {
    ...(ctx ?? {}),
    targetStart: startLine,
    targetEnd:   endLine,
  };
  const reindented = isRmd
    ? reindentRmdChunks(allLines, opts, rangedCtx)
    : reindentLines(allLines, opts, rangedCtx);

  const edits: vscode.TextEdit[] = [];
  for (let i = startLine; i <= endLine; i++) {
    if (reindented[i] !== allLines[i]) {
      const lineRange = document.lineAt(i).range;
      edits.push(vscode.TextEdit.replace(lineRange, reindented[i]));
    }
  }

  return { edits, reindented };
}


// ─── Command handler ──────────────────────────────────────────────────────────

function reindentLinesCommand(editor: vscode.TextEditor): void {
  const doc  = editor.document;
  const opts = getOptions();

  if (!R_LANG_IDS.has(doc.languageId)) {
    vscode.window.showWarningMessage(
      'R Reindent: command is only available for R, Quarto, and R Markdown files.'
    );
    return;
  }

  // Empty-selection on a blank/whitespace-only line: compute the expected
  // indent for that line and move the cursor to the end of it. All other
  // blank lines in the document are still preserved unchanged.
  const cursorLine = editor.selection.active.line;
  const cursorCol  = editor.selection.active.character;
  const oldLineText = doc.lineAt(cursorLine).text;
  const onBlankLine =
    editor.selection.isEmpty && oldLineText.trim() === '';
  // Empty-selection on a non-blank line: we'll reposition the cursor relative
  // to the line's non-whitespace content after the reindent.
  const onSingleLine = editor.selection.isEmpty && !onBlankLine;

  // If nothing is selected, operate on just the current line.
  let range: vscode.Range;
  if (editor.selection.isEmpty) {
    range = new vscode.Range(
      new vscode.Position(cursorLine, 0),
      new vscode.Position(cursorLine, doc.lineAt(cursorLine).text.length),
    );
  } else {
    // Expand selection to full lines so partial-line selections work cleanly.
    range = new vscode.Range(
      new vscode.Position(editor.selection.start.line, 0),
      new vscode.Position(editor.selection.end.line,
        doc.lineAt(editor.selection.end.line).text.length),
    );
  }

  const ctx: ReindentCtx | undefined = onBlankLine
    ? { blankIndentFor: cursorLine }
    : undefined;
  const { edits, reindented } = computeEdits(doc, range, opts, ctx);

  // Cursor target col for the blank-line case: length of the computed indent.
  // Only move the cursor if an indent was actually produced (col > 0) — a
  // top-level blank line (col === 0) is left alone so Ctrl+I stays a no-op.
  const blankTargetCol = onBlankLine ? reindented[cursorLine].length : 0;
  // Cursor target col for the single-line case: tracks the line's
  // non-whitespace content across the indent change.
  const singleTargetCol = onSingleLine
    ? adjustCursorAfterReindent(oldLineText, reindented[cursorLine], cursorCol)
    : 0;

  const moveCursorTo = (col: number) => {
    const pos = new vscode.Position(cursorLine, col);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos));
  };

  if (edits.length === 0) {
    if (onBlankLine && blankTargetCol > 0
        && editor.selection.active.character !== blankTargetCol) {
      // Line already holds the right indent but the cursor is elsewhere on it.
      moveCursorTo(blankTargetCol);
    } else if (onSingleLine && singleTargetCol !== cursorCol) {
      // Line indent unchanged, but cursor was in the leading whitespace and
      // should snap to the start of non-whitespace content.
      moveCursorTo(singleTargetCol);
    } else {
      vscode.window.setStatusBarMessage('R Reindent: no changes', 2000);
    }
    return;
  }

  editor.edit(editBuilder => {
    for (const edit of edits) {
      editBuilder.replace(edit.range, edit.newText);
    }
  }).then(success => {
    if (!success) return;
    if (onBlankLine && blankTargetCol > 0) {
      moveCursorTo(blankTargetCol);
    } else if (onSingleLine) {
      moveCursorTo(singleTargetCol);
    }
    vscode.window.setStatusBarMessage(
      `R Reindent: ${edits.length} line${edits.length !== 1 ? 's' : ''} changed`,
      2000,
    );
  });
}


// ─── Formatting provider ──────────────────────────────────────────────────────

/**
 * DocumentRangeFormattingEditProvider — integrates with VSCode's format-
 * selection (Shift+Alt+F / right-click → Format Selection).
 *
 * Note: VSCode's formattingOptions.tabSize / insertSpaces are available here,
 * but we prefer our own setting so the user can configure independently of the
 * editor's global tab size.
 */
class RReindentFormattingProvider
  implements vscode.DocumentRangeFormattingEditProvider
{
  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    _formattingOptions: vscode.FormattingOptions,
    _token: vscode.CancellationToken,
  ): vscode.TextEdit[] {
    // Formatter path deliberately omits the ctx arg: Shift+Alt+F must never
    // fill blank lines with whitespace — that behavior belongs to Ctrl+I only.
    return computeEdits(document, range, getOptions()).edits;
  }
}


// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Register the palette / keybinding command
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      'r-reindent.reindentLines',
      reindentLinesCommand,
    )
  );

  // Register as a formatting provider so Format Selection also uses us
  context.subscriptions.push(
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      LANG_SELECTOR,
      new RReindentFormattingProvider(),
    )
  );
}

export function deactivate(): void {
  // Nothing to clean up — subscriptions disposed automatically
}
