# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small VSCode extension (~550 LOC of TypeScript across 2 files) that ports RStudio's vertical-argument-alignment reindenter to VSCode for R, Quarto (`.qmd`), and R Markdown (`.Rmd`) files. User-visible behaviour is documented in [README.md](README.md).

## Commands

- `npm install` — install dependencies.
- `npm run compile` — one-shot TypeScript build (`tsc -p ./` → `out/`).
- `npm run watch` — incremental rebuild on save.
- `npm test` — compile, then run the indenter fixture suite (see below). No VSCode runtime needed.
- End-to-end verification is still manual: press `F5` inside VSCode to launch an Extension Development Host, then exercise `Ctrl+I` / `Cmd+I` on an `.R` / `.Rmd` / `.qmd` file.
- Package for distribution: `npm install -g @vscode/vsce` then `vsce package` (produces `r-reindent-<version>.vsix`).

## Tests

The `test/` directory holds a fixture-based suite for the pure indenter:

- [test/runner.mjs](test/runner.mjs) — `node:test` runner. For each `test/fixtures/<section>/<case>.R`: reads the file as the expected output, strips all leading whitespace to get a flat input, runs `reindentLines` with default opts, and diffs against the expected.
- [test/fixtures/](test/fixtures) — one file per numbered case from the upstream ESS `RStudio-.R` reference (`ess-26.01.0/test/styles/RStudio-.R`), split by `### Section` / `## N` markers.
- [test/known-failures.txt](test/known-failures.txt) — xfail list. Entries are expected to fail; if one starts passing, the runner fails and prompts removal. Stale entries (IDs not matching a fixture) also fail the suite.
- [test/split-ess.mjs](test/split-ess.mjs) — one-shot splitter used to populate `fixtures/`. Only re-run when refreshing against a newer ESS reference.

When adding a new fixture by hand, name it under the matching section directory so it slots in with the rest.

## Architecture

Two files, deliberately separated:

- [src/extension.ts](src/extension.ts) — VSCode boundary. Registers the `r-reindent.reindentLines` command and a `DocumentRangeFormattingEditProvider` (so `Shift+Alt+F` / Format Selection routes through the same code). Reads settings from the `r-reindent` configuration section. **Never contains indent logic.**
- [src/indenter.ts](src/indenter.ts) — Pure algorithm, no `vscode` imports. Exports `reindentLines(lines, opts)` and `reindentRmdChunks(lines, opts)`. Can be exercised in isolation.

### Non-obvious invariants

Preserve these when editing — they are easy to break silently.

1. **Always reindent the full document (or full R chunk), even when the user only selected a few lines.** `computeEdits` in [src/extension.ts:55](src/extension.ts:55) deliberately feeds all prior lines into the reindenter, then filters the emitted edits down to the requested range. The streaming algorithm needs prior lines to know the current bracket stack and continuation state — it cannot start mid-file.
2. **Streaming single-pass order matters.** In `reindentLines` at [src/indenter.ts:261](src/indenter.ts:261), each line is reindented *first*, then tokenized, so bracket column positions pushed onto the stack reflect the final layout. Swapping this order silently breaks vertical alignment for nested calls.
3. **Top-level continuation tracking has two parts.** `topLevelStarts` records lines that began with an empty bracket stack; `topLevelContinuations` only records those that also ended with an empty stack *and* a trailing continuation operator. This distinction prevents operators inside function calls (e.g. `foo(x +\n y)`) from being treated as pipe-chain continuations.
4. **Blank lines are hard chain boundaries; comment lines are transparent within a chain.** See `prevTopLevel` / `chainRootIndent` at [src/indenter.ts:200](src/indenter.ts:200).
5. **`.qmd` / `.Rmd` handling: only R fenced blocks are touched, each with a fresh bracket stack.** See `extractRRanges` / `reindentRmdChunks` at [src/indenter.ts:348](src/indenter.ts:348). Prose, YAML front matter, and non-R fences are returned unchanged.
6. **String/comment blanking is column-preserving.** `blankStringsAndComments` at [src/indenter.ts:117](src/indenter.ts:117) replaces string contents and `#` comments with spaces (not deletion) so column indices computed on the cleaned line still match columns in the original. R raw strings (`r"(...)"`, `R"[...]"`, etc.) are handled.

## Settings

User-facing config lives under the `r-reindent` section (see [package.json](package.json)):

- `r-reindent.verticalAlign` (bool, default `true`) — align to the column after `(`; `false` uses a one-tab-stop fallback.
- `r-reindent.tabWidth` (number, default `2`, clamped 1–8).

The extension deliberately does **not** use VSCode's `editor.tabSize` — the algorithm needs its own tab width independent of the editor's global setting.

## Language IDs

The extension activates on language IDs `r`, `rmd`, and `quarto` (see the `when` clauses in [package.json](package.json)). RMD-style chunk extraction is applied to `rmd` and `quarto`; plain `r` files are treated as a single chunk.
