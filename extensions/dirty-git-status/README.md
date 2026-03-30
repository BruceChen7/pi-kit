# Dirty Git Status Extension

Checks git status when Pi starts a session and prompts for commit if there are uncommitted changes.

## Behavior
- Checks dirty state on:
  - `session_start`
  - `session_switch`
- Dirty detection uses `git status --porcelain`.
- Prompt frequency is session-scoped: once while dirty; reset after repo becomes clean.
- If user confirms, extension runs:
  - `git add -A`
  - `git commit -m <message>`
- Keeps a manual command for on-demand commit flow.

## Manual Command
- `/commit-now` — trigger the same auto-commit flow manually.

## Commit Message Strategy
`dirtyGitStatus.commitMessageMode` supports:
- `auto` — always use default message
- `auto_with_override` (default) — use user input when provided, else default
- `ask` — require explicit message in UI (non-UI falls back to default)

Default commit message:
- `chore: auto-commit workspace changes`

## Configuration
Set in global `~/.pi/agent/settings.json` or project `<repo>/.pi/settings.json`:

```json
{
  "dirtyGitStatus": {
    "enabled": true,
    "checkOnSessionStart": true,
    "timeoutMs": 2000,
    "promptFrequency": "once_per_dirty_session",
    "commitMessageMode": "auto_with_override",
    "defaultCommitMessage": "chore: auto-commit workspace changes"
  }
}
```

## Notes
- Non-git directories are no-op.
- Non-UI sessions do not block execution; they skip confirmation UI.
- If there is nothing staged after `git add -A`, no commit is created.
