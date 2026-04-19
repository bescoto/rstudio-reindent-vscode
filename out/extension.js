"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const indenter_1 = require("./indenter");
// Language IDs recognised by VSCode for R-family files.
// 'r'      — base R language support (e.g. REditorSupport.r extension)
// 'rmd'    — R Markdown (some extensions use this)
// 'quarto' — Quarto (quarto.quarto extension)
const R_LANG_IDS = new Set(['r', 'rmd', 'quarto']);
const RMD_LANG_IDS = new Set(['rmd', 'quarto']);
const LANG_SELECTOR = [
    { language: 'r' },
    { language: 'rmd' },
    { language: 'quarto' },
];
// ─── Read user settings ───────────────────────────────────────────────────────
function getOptions() {
    const cfg = vscode.workspace.getConfiguration('r-reindent');
    return {
        verticalAlign: cfg.get('verticalAlign', true),
        tabWidth: cfg.get('tabWidth', 2),
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
function computeEdits(document, range, opts, ctx) {
    const startLine = range.start.line;
    const endLine = range.end.line;
    // Collect the lines we'll work on.
    // For the reindenter to compute correct context, we always pass lines from
    // the TOP of the document (or top of the R chunk for .qmd/.Rmd) to the end
    // of the selection. The algorithm needs prior lines to determine indent.
    const allLines = [];
    for (let i = 0; i < document.lineCount; i++) {
        allLines.push(document.lineAt(i).text);
    }
    const isRmd = RMD_LANG_IDS.has(document.languageId);
    // Reindent the full document (or all chunks) so context is correct, then
    // only emit edits for lines inside the requested range.
    const reindented = isRmd
        ? (0, indenter_1.reindentRmdChunks)(allLines, opts, ctx)
        : (0, indenter_1.reindentLines)(allLines, opts, ctx);
    const edits = [];
    for (let i = startLine; i <= endLine; i++) {
        if (reindented[i] !== allLines[i]) {
            const lineRange = document.lineAt(i).range;
            edits.push(vscode.TextEdit.replace(lineRange, reindented[i]));
        }
    }
    return { edits, reindented };
}
// ─── Command handler ──────────────────────────────────────────────────────────
function reindentLinesCommand(editor) {
    const doc = editor.document;
    const opts = getOptions();
    if (!R_LANG_IDS.has(doc.languageId)) {
        vscode.window.showWarningMessage('R Reindent: command is only available for R, Quarto, and R Markdown files.');
        return;
    }
    // Empty-selection on a blank/whitespace-only line: compute the expected
    // indent for that line and move the cursor to the end of it. All other
    // blank lines in the document are still preserved unchanged.
    const cursorLine = editor.selection.active.line;
    const onBlankLine = editor.selection.isEmpty && doc.lineAt(cursorLine).text.trim() === '';
    // If nothing is selected, operate on the entire document.
    let range;
    if (editor.selection.isEmpty) {
        range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length));
    }
    else {
        // Expand selection to full lines so partial-line selections work cleanly.
        range = new vscode.Range(new vscode.Position(editor.selection.start.line, 0), new vscode.Position(editor.selection.end.line, doc.lineAt(editor.selection.end.line).text.length));
    }
    const ctx = onBlankLine
        ? { blankIndentFor: cursorLine }
        : undefined;
    const { edits, reindented } = computeEdits(doc, range, opts, ctx);
    // Cursor target col for the blank-line case: length of the computed indent.
    // Only move the cursor if an indent was actually produced (col > 0) — a
    // top-level blank line (col === 0) is left alone so Ctrl+I stays a no-op.
    const blankTargetCol = onBlankLine ? reindented[cursorLine].length : 0;
    if (edits.length === 0) {
        if (onBlankLine && blankTargetCol > 0
            && editor.selection.active.character !== blankTargetCol) {
            // Line already holds the right indent but the cursor is elsewhere on it.
            const pos = new vscode.Position(cursorLine, blankTargetCol);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos));
        }
        else {
            vscode.window.setStatusBarMessage('R Reindent: no changes', 2000);
        }
        return;
    }
    editor.edit(editBuilder => {
        for (const edit of edits) {
            editBuilder.replace(edit.range, edit.newText);
        }
    }).then(success => {
        if (!success)
            return;
        if (onBlankLine && blankTargetCol > 0) {
            const pos = new vscode.Position(cursorLine, blankTargetCol);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos));
        }
        vscode.window.setStatusBarMessage(`R Reindent: ${edits.length} line${edits.length !== 1 ? 's' : ''} changed`, 2000);
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
class RReindentFormattingProvider {
    provideDocumentRangeFormattingEdits(document, range, _formattingOptions, _token) {
        // Formatter path deliberately omits the ctx arg: Shift+Alt+F must never
        // fill blank lines with whitespace — that behavior belongs to Ctrl+I only.
        return computeEdits(document, range, getOptions()).edits;
    }
}
// ─── Activation ───────────────────────────────────────────────────────────────
function activate(context) {
    // Register the palette / keybinding command
    context.subscriptions.push(vscode.commands.registerTextEditorCommand('r-reindent.reindentLines', reindentLinesCommand));
    // Register as a formatting provider so Format Selection also uses us
    context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider(LANG_SELECTOR, new RReindentFormattingProvider()));
}
function deactivate() {
    // Nothing to clean up — subscriptions disposed automatically
}
//# sourceMappingURL=extension.js.map