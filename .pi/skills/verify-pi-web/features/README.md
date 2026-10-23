# pi-kit plugin verification map for pi-web

This directory is the maintained source for verifying that pi-kit plugins render in the pi-web browser host. Read this index before driving an instance, then use the matching feature file as the recipe.

Sibling map: [verify-pi-kit](../../verify-pi-kit/features/README.md) covers the same plugins under pi's own TUI/rpc runtime. A plugin can pass there and still fail here: pi-web reports `mode: "rpc"` but implements `ctx.ui.custom`, so the UI surfaces differ.

## Baseline preconditions

- Run from the pi-kit repository root.
- `pi-web` is on `PATH` (`which pi-web`) and its version is recorded in the run (`launch.json` does not pin it; read it from `pi-web --version` when reporting).
- `opencli doctor` is green before any browser step: Chrome running, extension connected.
- Every run starts its own instance through `node scripts/verify-pi-web.mjs serve ...`. Never drive the user's long-running instance (default port 30141) and never reuse an instance from an earlier run.
- The run's agent directory is disposable: `PI_CODING_AGENT_DIR=<runDir>/agent`. Sessions, auth and model cache land there.
- Evidence lives in `<runDir>/`. It must survive `stop`.

## Driving conventions

- Treat every command as literal. Keep flags and quoted text unchanged.
- One run verifies one plugin set. `serve` loads exactly the plugins you pass plus `extensions/shared`.
- Run `doctor` before any browser step. A failed doctor means the browser step would prove nothing: the plugin never loaded.
- Select the project with `?cwd=<urlencoded cwd>` instead of clicking through the directory picker.
- Send a slash command as `fill` → `click .chat-input-textarea` → `keys Enter`. `fill` alone leaves focus elsewhere and Enter is dropped.
- Confirm the send landed before asserting anything: the composer must no longer hold the text. A command that is still settling swallows the Enter; repeat click + Enter once.
- Assert on text the plugin writes, or on `role=dialog` / `role=status` / `.chat-input-textarea`. Never assert on pi-web chrome strings: the UI locale follows the browser (`发送` vs `Send`, `扩展面板` vs `Extension panel`).
- Close an open custom panel with `keys Escape` before typing anything else.

## Proof and skip reporting

- Passing proof is the `doctor.json` verdict plus a screenshot and a state snapshot from one driven feature.
- Failing proof names the signal that failed: plugin not loaded, command not registered, or UI not visible.
- Report an unreachable path with the attempted command and the unmet precondition (port in use, `opencli doctor` red, no `pi-web` binary).
- Do not weaken an expectation to make a recipe pass. Record the failure in that feature's `Gotchas`.
- A feature driven through a different entry point than the mapped one is not covered.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-pi-web` starts with `Preconditions:` and pairs each action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Extension load](./extension-load.md) covers a plugin showing up in pi-web's own plugin runtime, with no browser.
- [Command output](./command-output.md) covers a slash command writing a line into the transcript and a `setStatus` status line.
- [Custom panel](./custom-panel.md) covers a `ctx.ui.custom()` panel rendered in the browser and closed from the keyboard.

## Uncovered surfaces

- **Extension widgets** (`setWidget`). No enabled plugin attaches a widget in a model-free, fresh-session state. `codex-plan-limits` needs a codex model and `plan-mode`'s TODO widget needs a TODO list. Add a feature file once a deterministic trigger exists.
- **Notify toasts** from `ctx.ui.notify` are observed inside the transcripts, not as a separate surface. No dedicated recipe yet.
- **Dialogs** (`select` / `confirm` / `input` / `editor`) are covered by pi-web's own e2e (`e2e/extension-dialog.mjs`) upstream; this map does not duplicate it.
