# Feature Workflow (Worktrunk)

A pi-kit extension that helps you start and manage feature development using Worktrunk (`wt`).

## Commands

- `/feature-start`
  - Interactive wizard to create a new feature branch + worktree via `wt switch --create`.
  - Base branch options are derived from **local branches**, prioritized as:
    1) current branch
    2) `main`
    3) `master`
    4) `release*` (e.g. `release`, `release/*`, `release-*`) if present

- `/feature-list`
  - Lists feature records stored under `<repo>/.pi/features/*.json`.

- `/feature-switch <id|slug|branch>`
  - Ensures the worktree exists via `wt switch` and prints the `cd <worktree>` instruction.
  - Note: pi cannot automatically change its own `cwd`; you typically `cd` into the worktree and start a new pi session there.

- `/feature-validate`
  - Runs basic preflight checks (dirty state + base freshness for the top-priority base).

## Storage

Feature metadata is stored per repo:

- `<repo>/.pi/features/<feature-id>.json`

## Configuration

Configure via global `~/.pi/agent/third_extension_settings.json` or project `<repo>/.pi/third_extension_settings.json`:

```json
{
  "featureWorkflow": {
    "enabled": true,
    "guards": {
      "requireCleanWorkspace": true,
      "requireFreshBase": true,
      "enforceBranchNaming": true
    },
    "defaults": {
      "gitTimeoutMs": 5000
    }
  }
}
```

## Requirements

- Worktrunk (`wt`) installed and available on `PATH`.
- Repository managed by Worktrunk (recommended).
