/**
 * extension.ts — R Reindent Lines VSCode extension
 *
 * Registers:
 *   • Command "R: Reindent Lines"  (palette + context menu + keybinding)
 *   • DocumentRangeFormattingEditProvider for R / Quarto / RMarkdown
 *
 * The command operates on the current selection, or the whole document if
 * nothing is selected — mirroring RStudio's Ctrl+I / Cmd+I behaviour.
 *
 * The formatting provider integrates with VSCode's built-in format-selection
 * (Ctrl+K Ctrl+F / Shift+Alt+F) so the extension also participates in the
 * standard formatting pipeline.
 */

import * as vscode from 'vscode';
import { reindentLines, reindentRmdChunks, ReindentOptions } from './indenter';

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
): vscode.TextEdit[] {
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

  // Reindent the full document (or all chunks) so context is correct, then
  // only emit edits for lines inside the requested range.
  const reindented = isRmd
    ? reindentRmdChunks(allLines, opts)
    : reindentLines(allLines, opts);

  const edits: vscode.TextEdit[] = [];
  for (let i = startLine; i <= endLine; i++) {
    if (reindented[i] !== allLines[i]) {
      const lineRange = document.lineAt(i).range;
      edits.push(vscode.TextEdit.replace(lineRange, reindented[i]));
    }
  }

  return edits;
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

  // If nothing is selected, operate on the entire document.
  let range: vscode.Range;
  if (editor.selection.isEmpty) {
    range = new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length),
    );
  } else {
    // Expand selection to full lines so partial-line selections work cleanly.
    range = new vscode.Range(
      new vscode.Position(editor.selection.start.line, 0),
      new vscode.Position(editor.selection.end.line,
        doc.lineAt(editor.selection.end.line).text.length),
    );
  }

  const edits = computeEdits(doc, range, opts);
  if (edits.length === 0) {
    vscode.window.setStatusBarMessage('R Reindent: no changes', 2000);
    return;
  }

  editor.edit(editBuilder => {
    for (const edit of edits) {
      editBuilder.replace(edit.range, edit.newText);
    }
  }).then(success => {
    if (success) {
      vscode.window.setStatusBarMessage(
        `R Reindent: ${edits.length} line${edits.length !== 1 ? 's' : ''} changed`,
        2000,
      );
    }
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
    return computeEdits(document, range, getOptions());
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
