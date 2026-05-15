# cr-diffview

`/cr` starts a human code-review flow in a right-side tmux pane using Neovim and
`diffview.nvim`.

## Requirements

- tmux
- Neovim on `PATH` as `nvim`
- A Neovim module available as `require("pi.cr")`
- `diffview.nvim` configured in Neovim

## Usage

- `/cr` opens an interactive selector:
  - staged changes (`DiffviewOpen --staged`)
  - unstaged changes (`DiffviewOpen`)
  - base branch diff (`DiffviewOpen <branch>...HEAD`)
- `/cr main` skips the selector and opens `main...HEAD`.

The Pi side passes review context to Neovim through environment variables:

- `CR_DIFF_TARGET`
- `CR_DIFF_ARGS`
- `CR_ANNOTATIONS_PATH`
- `CR_NVIM_SOCKET`

Neovim writes JSONL annotations to `CR_ANNOTATIONS_PATH`; Pi reads them after the
pane command returns and sends them back into the current conversation.
