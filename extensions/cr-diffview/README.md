# cr-diffview

`/cr-neovim-start` starts a human code-review flow in a dedicated terminal
review view named `pi-cr-<repo>`, using Neovim and a review.nvim-style review
UI (`lua/pi/cr` in the user's Neovim config). The shortcut `Alt+R` starts the
same flow with the interactive target picker.

## Requirements

| Requirement | Details |
| --- | --- |
| Git repository | The current directory must be inside a git work tree |
| Terminal | **tmux or herdr, OR a plain interactive terminal** — with tmux/herdr the review opens in a dedicated review view; without either, Pi suspends its TUI and launches Neovim in the foreground terminal (like Ctrl+G), resuming when Neovim exits |
| Neovim | On `PATH` as `nvim` |
| `pi.cr` module | Available in the Neovim config (`lua/pi/cr/init.lua`), auto-started via the `CR_SOCKET` environment variable or the launch entrypoint |

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

The review UI mirrors review.nvim's interaction:

| Feature | Keys | Details |
| --- | --- | --- |
| Sidebar | — | Files/Comments list with Staged/Unstaged sections (worktree scopes) |
| Diff pane | `{` / `}` | Unified diff with 20 context lines by default, expandable (20 → 50 → 100 → full file) |
| Commenting | `c`, `dc` | Typed comments (Fix / Note / Question with templates) on diff lines |
| Navigation | `]c`/`[c`, `]f`/`[f` | Hunk / file navigation |
| Stage/unstage | `Space` | Toggle staging; files move between the two sidebar sections |
| Exit flow | `q` → exit menu, `e` | Send the comments back to Pi, or open the real file directly in a new tab (`q` in the file returns to the review) |
| Submit/discard | `:qa`, `:qa!` | `:qa` submits the comments; `:qa!` discards them and quits |

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
