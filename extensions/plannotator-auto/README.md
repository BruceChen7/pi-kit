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
- `plannotator_auto_submit_review` is the only plan/spec review runner. While it waits for a result, the same session will not ask for another submit; approval clears the pending target, while denial keeps it pending for a later retry. Denied retries should revise the same file and preserve the first `#` heading so Plannotator can show version diffs. Manual review re-arms an approved (settled) file — see [Manual review re-arms the gate](#manual-review-re-arms-the-gate-until-approval).
- `/plannotator-review` opens an interactive plan/spec file picker and submits the selected file for Plannotator review.
- `Ctrl+Shift+R` opens the same plan/spec file picker.
- `Ctrl+Alt+L` annotates the latest Markdown or HTML file modified in the current session.

### Manual review re-arms the gate (until approval)

Both manual entries feed the same state machine, so a file that was approved earlier in the
session (settled → silent) is re-armed as soon as you review it by hand:
- `Ctrl+Shift+R` / `/plannotator-review` — file picker → Plannotator review
- `Ctrl+Alt+L` — annotate the latest Markdown/HTML document modified in this session

| Manual verdict                                | Pending target | Auto review                                                 |
| --------------------------------------------- | -------------- | ----------------------------------------------------------- |
| `approved`                                    | cleared        | settled — later edits stay silent                           |
| deny / `annotated` (with or without feedback) | cleared        | armed — later edits queue again                             |
| `dismissed`                                   | cleared        | armed (same as the auto flow: dismissal is not an approval) |
| no verdict (CLI error / abort / empty output) | kept           | unchanged                                                   |

"Cleared" means the revision you just reviewed leaves the pending queue, so the agent is not
asked to auto-submit that same revision again. Only auto-review targets (`plan` / `specs`
directories and `.pi/html/<repo>/`) are affected: manually reviewing any other `.pi/`
document (teach notes, `issues/`, `SKILL.md`, …) leaves the auto review queue untouched.

A manual verdict stays claimable by `plannotator_auto_submit_review`: with no pending target
left, calling the tool for that path reports it once (`details.status` = `approved` / `denied`)
instead of erroring. Approval therefore stays observable through the tool result — which is
where `plan-mode` reads it from — so a manual approval unlocks the plan phase exactly like an
auto approval does, and the plan gate is not left waiting for a review that can never run.

### Backends by file type

- **Markdown** (plan/spec/issue) → plan-review hook mode so version history and plan diffs are available (`plannotator` CLI with a PermissionRequest hook payload). Hosted in the **regular browser by default**; use `/plannotator-review-host` to temporarily switch a session to the Herdr terminal-browser panel.
- **HTML** (plan `.html` and `.pi/html/` artifacts) → one-shot annotate review (`plannotator annotate <file> --gate --json`). Always hosted in the regular browser (never the Herdr panel). The CLI blocks until the reviewer decides in the browser, then emits a decision JSON: `approved` clears the pending target and settles the path, `annotated` keeps it pending (denied semantics — revise and resubmit), `dismissed` releases the gate without settling (the next write re-queues). Re-submissions automatically show a version diff vs the previous submission (the CLI keeps per-file annotate history), replacing the old `--agent-reply` round-trip. Interrupted submits keep no session state — a retry simply re-runs the annotate command.

### Review hosting toggle

`/plannotator-review-host` flips how **Markdown** reviews are hosted for the current session (no arguments, toggle both ways):
- `browser` (default): the plannotator CLI opens the review in your regular browser.
- `herdr-panel` (temporary): the review opens in a `terminal-browser` panel split to the right of the current Herdr pane — or a new tab when a right pane already exists — and is auto-closed on a terminal verdict.

HTML artifacts always use the regular browser, regardless of the toggle. The toggle is session-scoped: a new session resets to `browser`. Switching to `herdr-panel` when the runtime cannot support it (not a Herdr environment, or `terminal-browser` not on `PATH`) is rejected with a warning and the mode stays `browser`.

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
