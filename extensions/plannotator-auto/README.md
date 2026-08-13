# Plannotator Auto

Auto-detects generated plan/spec files, gates the next agent turn until the agent explicitly submits the pending draft to Plannotator.

## What it watches

Auto review (pending-gate → `plannotator_auto_submit_review`) accepts only files in
`plan` / `specs` directories and HTML artifact dirs:

- Plans: any directory named `plan` — `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md` or `.html`
- Specs: any directory named `specs` — `.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md` (`.md` only)
- HTML artifacts: `.pi/html/<repo>/YYYY-MM-DD-<slug>.html`

Everything else under `.pi/` (teach workspaces, `issues/`, `shaping/`, notes, …) never
queues an auto review. Review those files manually with the picker (`Ctrl+Shift+R`) or
`Ctrl+Alt+L`, which scan all of `.pi/`.

All review locations are convention-based and NOT configurable: any directory named
`plan` / `specs` under `.pi/` (covering every repo slug and worktree alias), and
`.pi/html/<repo>/` for HTML artifacts.

## What it does

- `write` / `edit` to a matching **plan** file (`.md` or `.html`) → queue a pending plan review gate.
- `write` / `edit` to a matching **spec** file (`.md` only) → queue a pending spec review gate.
- Matching `bash` output redirects are treated the same as `write` / `edit`.
- When a plan/spec review target is pending, emit a handled pending-review event and use a hidden next-turn gate that requires `plannotator_auto_submit_review`.
- Multiple review-target writes before submission are tracked by target path and shown together in the pending gate.
- `plannotator_auto_submit_review` is the only plan/spec review runner. While it waits for a result, the same session will not ask for another submit; approval clears the pending target, while denial keeps it pending for a later retry. Denied retries should revise the same file and preserve the first `#` heading so Plannotator can show version diffs.
- `/plannotator-review` opens an interactive plan/spec file picker and submits the selected file for Plannotator review.
- `Ctrl+Shift+R` opens the same plan/spec file picker.
- `Ctrl+Alt+L` annotates the latest Markdown or HTML file modified in the current session.

### Backends by file type

- **Markdown** (plan/spec/issue) → plan-review hook mode so version history and plan diffs are available (`plannotator` CLI with a PermissionRequest hook payload).
- **HTML** (plan `.html` and `.pi/html/` artifacts) → one-shot annotate review (`plannotator annotate <file> --gate --json`). The CLI blocks until the reviewer decides in the browser, then emits a decision JSON: `approved` clears the pending target and settles the path, `annotated` keeps it pending (denied semantics — revise and resubmit), `dismissed` releases the gate without settling (the next write re-queues). Re-submissions automatically show a version diff vs the previous submission (the CLI keeps per-file annotate history), replacing the old `--agent-reply` round-trip. Interrupted submits keep no session state — a retry simply re-runs the annotate command.

## Configuration

None. All review locations are convention-based (`plan` / `specs` directories under
`.pi/`, and `.pi/html/<repo>/` for HTML artifacts); any legacy `plannotatorAuto`
settings (`planFile`, `htmlDirs`) are ignored.

## CLI commands used

Plannotator Auto requires the `plannotator` CLI to be available on `PATH`.

- `plannotator` with a PermissionRequest hook payload on stdin for Markdown plan/spec/issue review
- `plannotator annotate <file> --json` for manual Markdown annotation
- `plannotator annotate <file> --gate --json` for HTML artifact review (pending-gate flow)

## Logging

Logs use the shared extension logger (default file: `~/.pi/agent/pi-debug.log`).

Useful filters:

- `ext:plannotator-auto`
- `sessionKey`
