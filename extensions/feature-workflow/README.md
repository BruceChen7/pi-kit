# Feature Workflow (Worktrunk)

A pi-kit extension that helps you start and manage feature development using Worktrunk (`wt`).

## Commands

- `/feature-setup [profile] [--only=<targets>] [--skip=<targets>] [--yes]`
  - Bootstraps repo-local ignored-sync + Worktrunk hook setup.
  - Extensible **profile registry** (currently ships with `npm`; designed to add `pnpm`/`yarn`/custom profiles later).
  - Generates/updates profile artifacts idempotently (safe to run repeatedly).
  - Targets:
    - `settings` → `.pi/third_extension_settings.json`
    - `gitignore` → ensure `.pi/` and `.config/wt.toml` exist in `.gitignore`
    - `worktreeinclude` → `.worktreeinclude`
    - `hook-script` → `$HOME/.pi/pi-feature-workflow-links.sh`
    - `wt-toml` → managed hook block in `.config/wt.toml`

- `/feature-start`
  - Interactive wizard to create a new feature branch + worktree via `wt switch --create`.
  - Prompts only for:
    1) `Branch slug:`
    2) `Base branch:`
  - Applies the same `.gitignore` merge rule as `/feature-setup` in the new worktree (ensures `.pi/` exists without overwriting existing target rules).
  - Records successful creations in a repo-local managed-feature registry under `.pi/` so later commands only operate on feature-workflow-managed branches.
  - If `defaults.autoSwitchToWorktreeSession` is enabled (default: true), pi will switch into a new session whose `cwd` is the worktree path.
  - Base branch options are derived from **local branches**, prioritized as:
    1) current branch
       - if current branch is a managed feature branch in `<base>/<slug>` form, prioritize its parsed `base`
    2) `main`
    3) `master`
    4) `release*` (e.g. `release`, `release/*`, `release-*`) if present
  - New feature branches embed base in name: `<base>/<slug>` (example: `main/checkout-v2`).

- `/feature-list`
  - Lists active feature worktrees from `wt list --format json`.
  - Only shows branches that are both:
    - active in Worktrunk, and
    - present in the feature-workflow managed registry
  - Derives `base` from branch name (`<base>/<slug>`).

- `/feature-switch <branch|slug>`
  - Canonical lookup key is **branch name** (`<base>/<slug>`). UI selection also uses branch names to avoid ambiguity.
  - A unique `slug` is accepted as a convenience alias. If a slug matches multiple branches, the command asks you to use the full branch name.
  - Ensures the worktree exists via `wt switch`.
  - Applies the same `.gitignore` merge rule as `/feature-setup` in the target worktree (ensures `.pi/` exists without overwriting existing target rules).
  - If `defaults.autoSwitchToWorktreeSession` is enabled (default: true), pi will switch into a worktree session rooted at that feature.

- `/feature-validate`
  - Runs basic preflight checks (dirty state + base freshness for the top-priority base).

## Common workflow (beginner-friendly)

If you're new to this extension, follow this flow first. Think of it as a simple “setup once → create feature → switch back later → validate before PR” process.

### 1) One-time setup for a repository

Run this once in your repo:

```text
/feature-setup npm
```

This command prepares the files needed for ignored-sync and Worktrunk hooks:

- `.pi/third_extension_settings.json`
- `.gitignore` (ensures `.pi/` and `.config/wt.toml` are present)
- `.worktreeinclude`
- `$HOME/.pi/pi-feature-workflow-links.sh`
- `.config/wt.toml` (managed block)

After setup, repo-local `.pi` artifacts and `.config/wt.toml` stay local by default (both are gitignored), while the hook script is installed at `$HOME/.pi/pi-feature-workflow-links.sh`. Commit tracked workflow files like `.worktreeinclude` if you want to share them with your team.

### 2) Start a new feature

Run:

```text
/feature-start
```

Then follow the wizard:

1. enter a short slug (for example `checkout-v2`)
2. choose base branch (usually `main`)

The extension creates branch + worktree and (by default) switches you into that worktree session automatically.

Example branch name:

```text
main/checkout-v2
```

### 3) Continue an existing feature later

List feature worktrees:

```text
/feature-list
```

Switch to one:

```text
/feature-switch main/checkout-v2
```

Tip: use the full branch name (`<base>/<slug>`) if the same slug exists under multiple base branches.

### 4) Run preflight checks before PR / before continuing work

```text
/feature-validate
```

This helps catch common issues early (dirty workspace, stale base).

### 5) Typical daily command loop

```text
# start a new branch
/feature-start

# later switch back into an existing feature
/feature-list
/feature-switch main/checkout-v2

# before push / PR
/feature-validate
```

## Storage

Feature/worktree visibility uses two inputs:

1. Worktrunk (`wt list --format json`) for active worktrees
2. A repo-local feature-workflow managed registry under `.pi/`

Identity semantics:
- Canonical key: `branch`
- Convenience alias: unique `slug`

`base` is derived from branch name and requires:
- `<base>/<slug>`

This registry-based model ensures ordinary slash branches such as `user/demo` are not treated as feature-workflow branches unless they were created by `/feature-start`.

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
    },
    "ignoredSync": {
      "enabled": true,
      "mode": "quick",
      "ensureOn": ["feature-start", "feature-switch"],
      "rules": [
        {
          "path": "node_modules",
          "strategy": "symlink",
          "required": false,
          "onMissing": {
            "action": "run-hook",
            "hook": "project-deps-link"
          }
        },
        {
          "path": ".pi",
          "strategy": "symlink",
          "required": false,
          "onMissing": {
            "action": "run-hook",
            "hook": "project-deps-link"
          }
        },
        {
          "path": "AGENTS.md",
          "strategy": "copy",
          "required": false,
          "onMissing": {
            "action": "run-hook",
            "hook": "project-deps-link"
          }
        },
        {
          "path": "CLAUDE.md",
          "strategy": "copy",
          "required": false,
          "onMissing": {
            "action": "run-hook",
            "hook": "project-deps-link"
          }
        }
      ],
      "lockfile": {
        "enabled": false,
        "path": "package-lock.json",
        "compareWithPrimary": true,
        "onDrift": "warn"
      },
      "fallback": {
        "copyIgnoredTimeoutMs": 15000,
        "onFailure": "warn"
      },
      "notifications": {
        "enabled": true,
        "verbose": false
      }
    }
  }
}
```

> `/feature-setup npm` will upgrade this baseline with npm profile defaults (including lockfile drift warnings and managed hook/script artifacts).

### ignoredSync modes

- `quick` (default): session switch first, then best-effort sync and warnings.
- `strict`: sync before session switch. If required paths remain unresolved and `fallback.onFailure` is `block`, the command aborts.

## Fast bootstrap (recommended)

Use `/feature-setup` to install hook wiring (with a user-scoped script in `$HOME/.pi`):

```text
/feature-setup npm
```

By default this command updates:

- `.pi/third_extension_settings.json`
- `.gitignore` (adds `.pi/` and `.config/wt.toml` if missing)
- `.worktreeinclude`
- `$HOME/.pi/pi-feature-workflow-links.sh`
- `.config/wt.toml` (managed block)

Example managed block in `.config/wt.toml`:

```toml
# >>> pi-kit feature-workflow setup (managed) >>>
[pre-start]
"project-deps-link" = "bash \"$HOME/.pi/pi-feature-workflow-links.sh\" '{{ primary_worktree_path }}'"
# <<< pi-kit feature-workflow setup (managed) <<<
```

The generated script links profile-defined shared paths (npm profile: `node_modules`, `.pi`, `AGENTS.md`, `CLAUDE.md`) from primary worktree to feature worktree.

## Requirements

- Worktrunk (`wt`) installed and available on `PATH`.
- Repository managed by Worktrunk (recommended).
