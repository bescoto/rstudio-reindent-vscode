"use strict";
/**
 * cursor.ts — pure cursor-position helpers, no `vscode` import.
 *
 * Used by the Ctrl+I command path when reindenting a single line with an empty
 * selection: VSCode's default cursor tracking after a full-line replace is not
 * what users expect, so we compute the desired column ourselves.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.adjustCursorAfterReindent = adjustCursorAfterReindent;
/**
 * Compute the new cursor column on a line whose leading whitespace was changed
 * by reindent.
 *
 * Rules:
 *   • If the cursor was at or before the start of the non-whitespace content
 *     on the original line, it lands at the start of the non-whitespace on the
 *     reindented line (i.e. just past the new leading whitespace).
 *   • If the cursor was inside the non-whitespace content, its position
 *     relative to that content is preserved — so typing-context follows the
 *     code, not the column.
 */
function adjustCursorAfterReindent(oldLine, newLine, oldCol) {
    const oldNonWs = firstNonWs(oldLine);
    const newNonWs = firstNonWs(newLine);
    if (oldCol <= oldNonWs)
        return newNonWs;
    return newNonWs + (oldCol - oldNonWs);
}
function firstNonWs(line) {
    const m = line.match(/\S/);
    return m ? m.index : line.length;
}
//# sourceMappingURL=cursor.js.map