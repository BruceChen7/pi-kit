# cr-diffview

`/cr-neovim-start` starts a human code-review flow in a new tmux window named
`pi-cr`, using Neovim and `diffview.nvim`. The shortcut `Alt+R` starts the same
flow with the interactive target picker.

## Requirements

- A git repository
- tmux, with Pi running inside a tmux session
- Neovim on `PATH` as `nvim`
- A Neovim module available as `require("pi.cr")`
- `diffview.nvim` configured in Neovim

## Usage

- `/cr-neovim-start` opens an interactive selector:
  - review unstaged changes (`git diff`)
  - review staged changes (`git diff --cached`)
  - review against a base branch (`branch...HEAD`)
- `/cr-neovim-start main` skips the selector and opens `main...HEAD`.
- `Alt+R` opens the same interactive selector.
- `/cr-neovim-stop` closes the `pi-cr` tmux window and imports saved annotations.

While a review window is open, Pi shows a `cr-diffview` widget with the active
review target.

When you finish a review in Neovim or stop the review from Pi, any saved review
annotations are sent back into the current conversation as a follow-up user
message.
