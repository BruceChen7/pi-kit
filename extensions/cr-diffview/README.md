# cr-diffview

`/cr-neovim-start` starts a human code-review flow in a new tmux window named
`pi-cr-<repo>`, using Neovim and `codediff.nvim`. The shortcut `Alt+R` starts
the same flow with the interactive target picker.

## Requirements

- A git repository
- tmux, with Pi running inside a tmux session
- Neovim on `PATH` as `nvim`
- `codediff.nvim` configured in Neovim, with the `:CodeDiff` command available

## Usage

- `/cr-neovim-start` opens an interactive selector:
  - review unstaged changes (`git diff`)
  - review staged changes (`git diff --cached`)
  - review against a base branch (`branch...HEAD`)
- `/cr-neovim-start main` skips the selector and opens `CodeDiff main...HEAD`.
- `Alt+R` opens the same interactive selector.
- `/cr-neovim-stop` closes the active CR tmux window.

Staged-only and unstaged-only sessions use CodeDiff's explorer visible-groups
configuration for the launched Neovim process.

While a review window is open, Pi shows a `cr-diffview` widget with the active
review target.

## Annotation support

The previous `pi.cr`/`diffview.nvim` launcher could exchange saved annotations
through Pi's CR socket protocol. The current `codediff.nvim` launcher opens
`:CodeDiff` directly, so automatic annotation import is not available unless a
separate Neovim bridge connects to the CR socket and writes the annotation
artifact.
