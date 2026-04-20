# Plannotator Auto

Auto-triggers Plannotator reviews for generated plan/spec files, and can optionally auto-trigger code review for non-plan edits.

## What it watches

Default targets:

- Plans: `.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md`
- Specs: `.pi/plans/<repo>/specs/YYYY-MM-DD-<slug>-design.md`

When `planFile` is not explicitly configured, worktree sessions accept both aliases:

- `.pi/plans/<root-repo>/plan/`
- `.pi/plans/<cwd-basename>/plan/`

`specs/` is always resolved as the sibling directory of the active `plan/` directory.

## What it does

- `write` / `edit` to a matching **plan** file → queue and run plan review.
- `write` / `edit` to a matching **spec** file → queue and run spec review.
- Multiple plan writes before dispatch → keep only the latest pending plan file.
- `write` / `edit` to **non-plan** files → mark code review pending only if `codeReviewAutoTrigger` is `true`.
- On `agent_end`, if code review is pending and repo is dirty, request code review.
- `Ctrl+Alt+L` annotates the latest generated review target (latest mtime across plan/spec targets).

## Configuration

Global config file:

- `~/.pi/agent/third_extension_settings.json`

Example:

```json
{
  "plannotatorAuto": {
    "planFile": ".pi/plans/my-repo/plan",
    "codeReviewAutoTrigger": false
  }
}
```

Notes:

- `planFile` supports **directory path only**.
- Legacy single-file values like `.pi/PLAN.md` are ignored.
- Set `planFile: null` to disable plan/spec review auto-trigger.
- `codeReviewAutoTrigger` is disabled by default.

## Event actions used

- `plan-review`
- `code-review`
- `annotate`
- `review-status` (fallback polling)

## Logging

Logs use the shared extension logger (default file: `~/.pi/agent/pi-debug.log`).

Useful filters:

- `ext:plannotator-auto`
- `reviewId`
- `sessionKey`
