# Feature Workflow (Worktrunk)

A pi-kit extension for creating, switching, validating, and cleaning Worktrunk feature worktrees.

## Commands

### `/feature-setup [profile] [--only=<targets>] [--skip=<targets>] [--yes]`
Sets up repo/global artifacts used by feature-workflow.

Targets:

- `settings` → `.pi/third_extension_settings.json`
- `gitignore` → ensure `.pi/`, `.config/wt.toml`, and `.worktreeinclude` in `.gitignore`
- `worktreeinclude` → local `.worktreeinclude` whitelist for `wt step copy-ignored`
- `hook-script` → `$HOME/.pi/pi-feature-workflow-links.sh`
- `wt-toml` → managed hook block in `.config/wt.toml`
- `wt-user-config` → `~/.config/worktrunk/config.toml` `worktree-path`

### `/feature-start`
Interactive create + switch flow.

Prompts:

1. `Branch slug`
2. `Base branch`

Runs `wt switch --create`, then auto-switches pi session to the new worktree when enabled.

If `.worktreeinclude` is missing while `.config/wt.toml` still runs `wt step copy-ignored`, `/feature-start` warns because Worktrunk will otherwise copy all gitignored files.

### `/feature-list`
Lists active feature worktrees from `wt list --format json`.

### `/feature-switch <branch>`
Switches to an existing feature worktree by branch name using `wt switch`, then auto-switches pi session when enabled.

### `/feature-validate`
Runs preflight checks (workspace cleanliness, inferred base info, base freshness when available).

### `/feature-prune-merged [--yes] [--no-fetch]`
Removes merged/empty non-main worktrees.

- default: runs `git fetch --all --prune` first
- `--yes`: skip confirmation
- `--no-fetch`: skip fetch

## Recommended flow

```text
# one-time setup
/feature-setup npm

# start feature
/feature-start

# resume feature later
/feature-list
/feature-switch <branch>

# before push/PR
/feature-validate

# periodic cleanup
/feature-prune-merged
```

## Discovery and identity

- Source of truth: `wt list --format json`
- Canonical key: `branch`
- Base branch: inferred at runtime from git graph (`fork-point` first, fallback `merge-base`)

## Configuration

Config locations:

- global: `~/.pi/agent/third_extension_settings.json`
- project: `<repo>/.pi/third_extension_settings.json`

Example:

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
    },
    "ignoredSync": {
      "enabled": true,
      "mode": "quick",
      "ensureOn": ["feature-start", "feature-switch"]
    }
  }
}
```

## Hook behavior

After `/feature-setup`, hooks are managed via `.config/wt.toml` and `$HOME/.pi/pi-feature-workflow-links.sh`.

Managed block shape:

```toml
# >>> pi-kit feature-workflow setup (managed) >>>
[pre-start]
"project-deps-link" = "bash \"$HOME/.pi/pi-feature-workflow-links.sh\" '{{ primary_worktree_path }}'"

[post-start]
"project-copy-ignored" = "wt step copy-ignored"
# <<< pi-kit feature-workflow setup (managed) <<<
```

## Requirements

- `wt` (Worktrunk) installed and available on `PATH`
