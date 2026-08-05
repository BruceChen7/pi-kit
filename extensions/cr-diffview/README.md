# cr-diffview

`/cr-neovim-start` starts a human code-review flow in a dedicated terminal
review view named `pi-cr-<repo>`, using Neovim and a review.nvim-style review
UI (`lua/pi/cr` in the user's Neovim config). The shortcut `Alt+R` starts the
same flow with the interactive target picker.

## Requirements

- A git repository
- **tmux or herdr, OR a plain interactive terminal** — with tmux/herdr the
  review opens in a dedicated review view; without either, Pi suspends its TUI
  and launches Neovim in the foreground terminal (like Ctrl+G), resuming when
  Neovim exits
- Neovim on `PATH` as `nvim`
- The `pi.cr` module available in the Neovim config (`lua/pi/cr/init.lua`),
  auto-started via the `CR_SOCKET` environment variable or the launch entrypoint

## Usage

- `/cr-neovim-start` opens an interactive selector:
  - review unstaged changes (`git diff`)
  - review staged changes (`git diff --cached`)
  - review against a base branch (`branch...HEAD`)
- `/cr-neovim-start main` skips the selector and opens the review for `main...HEAD`.
- `Alt+R` opens the same interactive selector.
- `/cr-neovim-stop` closes the active CR review view (tmux/herdr modes). Without
  tmux/herdr (inline mode) the review is modal and ends when Neovim exits, so
  stop simply reports the review state instead of closing a view.

The review UI mirrors review.nvim's interaction: a Files/Comments sidebar with
a unified diff pane, typed comments (Fix / Note / Question with templates) on
diff lines (`c`, `dc`), hunk/file navigation (`]c`/`[c`, `]f`/`[f`), context
controls (`{`/`}`), stage/unstage (`Space`), and an exit menu that sends the
comments back to Pi (`q`) or opens the real file (`e`).

While a review window is open, Pi shows a `cr-diffview` widget with the active
review target (tmux/herdr modes).

## Annotation flow

Comments are appended to an artifact JSONL file as they are saved, and sent to
Pi over the CR socket when the review finishes (or via the artifact as a crash
fallback in inline mode). Pi receives them as a follow-up message in
review.nvim-style markdown with diff context, so the agent can act on them
directly.

The inline mode replicates Pi's Ctrl+G external-editor mechanism from the
extension (`tui.stop()` → foreground spawn → `tui.start()`); see the
`captureTui`/`runInlineReview` comments in `index.ts` for the upstream API
follow-up.
