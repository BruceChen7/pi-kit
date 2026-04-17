# Feature Workflow (Worktrunk)

A pi-kit extension that helps you start and manage feature development using Worktrunk (`wt`).

## Commands

- `/feature-start`
  - Interactive wizard to create a new feature branch + worktree via `wt switch --create`.
  - If `defaults.autoSwitchToWorktreeSession` is enabled (default: true), pi will switch into a new session whose `cwd` is the worktree path.
  - Base branch options are derived from **local branches**, prioritized as:
    1) current branch
    2) `main`
    3) `master`
    4) `release*` (e.g. `release`, `release/*`, `release-*`) if present
  - New feature branches embed base in name: `<type>/<base>/<slug>` (example: `feat/main/checkout-v2`).

- `/feature-list`
  - Lists active feature worktrees from `wt list --format json`.
  - Derives `base` from branch name (`<type>/<base>/<slug>`). Legacy `<type>/<slug>` branches are still listed with empty base.

- `/feature-switch <branch|id|slug>`
  - Canonical lookup key is **branch name** (`<type>/<base>/<slug>`). UI selection also uses branch names to avoid ambiguity.
  - `id` and `slug` are still accepted as aliases for compatibility. If an alias matches multiple branches, the command asks you to use the full branch name.
  - Ensures the worktree exists via `wt switch`.
  - If `defaults.autoSwitchToWorktreeSession` is enabled (default: true), pi will switch into a worktree session rooted at that feature.

- `/feature-validate`
  - Runs basic preflight checks (dirty state + base freshness for the top-priority base).

## Storage

Feature/worktree source of truth comes from Worktrunk (`wt list --format json`).

Identity semantics:
- Canonical key: `branch`
- Display alias: `id` (`<type>-<normalized-base>-<slug>`, or legacy `<type>-<slug>` when base is empty)

`base` is derived from branch name:
- Preferred: `<type>/<base>/<slug>`
- Legacy supported: `<type>/<slug>` (treated as empty base)

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
      "gitTimeoutMs": 5000,
      "autoSwitchToWorktreeSession": true
    }
  }
}
```

## Requirements

- Worktrunk (`wt`) installed and available on `PATH`.
- Repository managed by Worktrunk (recommended).
