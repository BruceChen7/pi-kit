# Plannotator Auto

Auto-detects generated plan/spec files, gates the next agent turn until the agent explicitly submits the pending draft to Plannotator, and supports configurable extra review targets.

## What it watches

Default targets:

- Plans: `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md` or `.html`
- Specs: `.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md`
- Issues: `.pi/plans/<repo>/issues/<topic-slug>/*.md`

When `planFile` is not explicitly configured, worktree sessions accept both aliases:

- `.pi/plans/<root-repo>/plan/`
- `.pi/plans/<cwd-basename>/plan/`

`specs/` is always resolved as the sibling directory of the active `plan/` directory.

## What it does

- `write` / `edit` to a matching **plan** file (`.md` or `.html`) → queue a pending plan review gate.
- `write` / `edit` to a matching **spec** file (`.md` only) → queue a pending spec review gate.
- `write` / `edit` to a matching **issue** file → queue a pending plan review gate.
- Matching `bash` output redirects are treated the same as `write` / `edit`.
- When a plan/spec/issue review target is pending, emit a handled pending-review event and use a hidden next-turn gate that requires `plannotator_auto_submit_review`.
- Multiple review-target writes before submission are tracked by target path and shown together in the pending gate.
- `plannotator_auto_submit_review` is the only plan/spec review runner. While it waits for a result, the same session will not ask for another submit; approval clears the pending target, while denial keeps it pending for a later retry. Denied retries should revise the same file and preserve the first `#` heading so Plannotator can show version diffs.
- `/plannotator-review` opens an interactive plan/spec file picker and submits the selected file for Plannotator review.
- `Ctrl+Shift+R` opens the same plan/spec file picker.
- `Ctrl+Alt+L` annotates the latest Markdown or HTML file modified in the current session.

### Backends by file type

- **Markdown** (plan/spec/issue) → plan-review hook mode so version history and plan diffs are available (`plannotator` CLI with a PermissionRequest hook payload).
- **HTML** (plan `.html` and `.pi/html/` artifacts) → one-shot annotate review (`plannotator annotate <file> --gate --json`). The CLI blocks until the reviewer decides in the browser, then emits a decision JSON: `approved` clears the pending target and settles the path, `annotated` keeps it pending (denied semantics — revise and resubmit), `dismissed` releases the gate without settling (the next write re-queues). Before opening, a static compliance gate blocks artifacts that would break inside the review sandbox (localStorage/history/location APIs) or miss keyboard fallbacks / review hints. Re-submissions automatically show a version diff vs the previous submission (the CLI keeps per-file annotate history), replacing the old `--agent-reply` round-trip. Interrupted submits keep no session state — a retry simply re-runs the annotate command.

### HTML artifact compliance rules (submit-time static gate)

- **R1 `sandbox-storage-unsafe`** (error for prototypes, warning otherwise): the script uses `localStorage` / `sessionStorage` / `history.replaceState` / `history.pushState` / `location.search` — all unusable inside the review sandbox (srcdoc iframe, `sandbox="allow-scripts"`, opaque origin).
- **R2 `keyboard-fallback-missing`** (warning): custom interactive controls (non-native `cursor:pointer` elements) exist but the script has no ArrowLeft/ArrowRight keydown handling, so pinpoint-mode reviews have no way to operate them.
- **R3 `review-hint-missing`** (warning, prototypes only): the top-of-file comment does not mention the review controls (drag-select = annotate, toolstrip input-method switch, resubmit shows a version diff).
- **R4 `script-absent-or-empty`** (error/warning): the artifact declares `<script>` tags but ships no executable JS (all inline blocks empty, no src), or interactive controls exist with no script at all — the review surface would be a blank page. Empty blocks alongside valid scripts downgrade to a warning.
- **R5 `script-before-dom-ready`** (error): an inline script placed before `<body>` (or before the `#app` root) touches the DOM (getElementById / querySelector / mount) without waiting for `DOMContentLoaded` — it runs before the body exists, `getElementById("app")` returns null, and the mount fails → blank page.
- **R6 `error-visibility-missing`** (warning): an app-like script (mount / getElementById / `$state`) has no `window.onerror` fallback. The review sandbox swallows console output, so runtime errors render as a blank page with no clue.

**Artifact author self-check** (what the gate verifies, do it locally before submitting):

1. Script content is non-empty (inline a real bundle, not an empty shell; inline by reading the `src` file, never by regex-matching a self-closing `<script src=...></script>` tag).
2. Script runs after the DOM is ready: place it at the end of `<body>` (after `#app`) or wrap in `DOMContentLoaded` — never in `<head>`.
3. Install a `window.onerror` fallback that paints the error text into the page (the review sandbox hides console output — without it, runtime errors look like a black screen).

**Black-screen triage order**: before suspecting the pipeline, check your own generated artifact — is the script content empty, is it placed after `#app`, does it wait for the DOM? The Plannotator pipeline rewrites only an in-memory copy for asset serving; it never rewrites your file on disk.

## Configuration

Global config file:

- `~/.pi/agent/third_extension_settings.json`

Example:

```json
{
  "plannotatorAuto": {
    "planFile": ".pi/plans/my-repo/plan",
    "htmlDirs": [".pi/html"],
    "callflowContext": true
  }
}
```

Notes:

- `planFile` supports **directory path only**.
- `htmlDirs` configures the HTML artifact review directories (default `[".pi/html"]`, resolved against the session cwd with the same repo-slug aliases as `planFile`); set `htmlDirs: null` or `[]` to disable HTML artifact review.
- Set `planFile: null` to disable plan/spec review auto-trigger.
- `callflowContext` (default off) appends a best-effort call-flow context appendix to the review payload when submitting a plan/spec — a `calldiff diff` summary (which entrypoints' call trees changed, with +/- counts and condensed ASCII trees). It never modifies the plan file on disk, and is skipped silently when the session is not a git repo, `calldiff` is unavailable, or nothing changed. Accepts `true`/`false` or `{ "enabled": true, "from": "HEAD~1" }` to choose the diff base ref. Requires the `calldiff` CLI (resolved from PATH with an npx fallback; first run downloads tree-sitter grammars into `~/.cache/calldiff`).

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
