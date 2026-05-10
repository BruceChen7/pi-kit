# Plannotator Auto

Auto-detects generated plan/spec files, gates the next agent turn until the agent explicitly submits the pending draft to Plannotator, supports configurable extra review targets, and can optionally auto-trigger code review for non-plan edits.

## What it watches

Default targets:

- Plans: `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md`
- Specs: `.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md`
- Issues: `.pi/plans/<repo>/issues/<topic-slug>/*.md`

When `planFile` is not explicitly configured, worktree sessions accept both aliases:

- `.pi/plans/<root-repo>/plan/`
- `.pi/plans/<cwd-basename>/plan/`

`specs/` is always resolved as the sibling directory of the active `plan/` directory.

Optional extra targets can be added with `plannotatorAuto.extraReviewTargets` as `{ dir, filePattern }` entries.

## What it does

- `write` / `edit` to a matching **plan** file → queue a pending plan review gate.
- `write` / `edit` to a matching **spec** file → queue a pending spec review gate.
- `write` / `edit` to a matching **issue** file → queue a pending plan review gate.
- Matching `bash` output redirects are treated the same as `write` / `edit`.
- When a plan/spec/issue review target is pending, emit a handled pending-review event and use a hidden next-turn gate that requires `plannotator_auto_submit_review`.
- Multiple review-target writes before submission are tracked by target path and shown together in the pending gate.
- `plannotator_auto_submit_review` is the only plan/spec review runner. While it waits for a result, the same session will not ask for another submit; approval clears the pending target, while denial keeps it pending for a later retry.
- `write` / `edit` to **non-plan** files → mark code review pending only if `codeReviewAutoTrigger` is `true`.
- On `agent_end`, if code review is pending, no plan/spec review is pending or active, and the repo is dirty, request code review.
- `Ctrl+Alt+L` annotates the latest Markdown file modified in the current session.

## Configuration

Global config file:

- `~/.pi/agent/third_extension_settings.json`

Example:

```json
{
  "plannotatorAuto": {
    "planFile": ".pi/plans/my-repo/plan",
    "extraReviewTargets": [
      {
        "dir": ".pi/plans/my-repo/office-hours",
        "filePattern": "^[^/]+-office-hours-\\d{8}-\\d{6}\\.md$"
      },
      {
        "dir": ".pi/plans/my-repo/plan-eng-review",
        "filePattern": "^[^/]+-test-plan-\\d{8}-\\d{6}\\.md$"
      }
    ],
    "codeReviewAutoTrigger": false
  }
}
```

Notes:

- `planFile` supports **directory path only**.
- `extraReviewTargets` entries use `{ dir, filePattern }`, where `filePattern` is a basename regex applied to direct child files only.
- Set `planFile: null` to disable plan/spec review auto-trigger.
- `codeReviewAutoTrigger` is disabled by default.

## Event actions used

- `plan-review`
- `code-review`
- `annotate`
- `review-status`

## Logging

Logs use the shared extension logger (default file: `~/.pi/agent/pi-debug.log`).

Useful filters:

- `ext:plannotator-auto`
- `reviewId`
- `sessionKey`
