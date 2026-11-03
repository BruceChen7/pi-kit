# Skill toggle

The skill-toggle plugin enables and disables managed skills. `/disabled-skills` prints the managed skills that are currently enabled. The readout has one write side effect: its handler calls `loadToggleState`, which best-effort creates missing symlinks under `.pi/skills` in the primary checkout (a linked worktree resolves to the primary root) before it formats the list.

## Sub-features

- `list-enabled-skills`: prints the managed skills that are currently enabled.

## How to get to it (user POV)

- Type `/disabled-skills` in any Pi session.

## Driving it with verify-plugin

Preconditions: repository root, `npm install` done, and `$HOME/.agents/git-skills` or `$HOME/.agents/me-skills` holds skills with a frontmatter `description`. Repo-side `.pi/skills` alone does not fill the list.
- Read the enabled skills:
  `node scripts/verify-plugin.mjs command --plugin skill-toggle --command "/disabled-skills" --expect "Enabled managed skills (" --reject "No enabled managed skills"`
  Observable: `PASS`, one notify starting with `Enabled managed skills (` and a populated name list.

## Gotchas

- The names come from the home skill library intersected with the enabled set. Five names are always excluded, and marker files under `.pi/disabled-skills` in the primary checkout exclude more (the helper normalises a worktree to its primary checkout; only files count, not directories). Assert the prefix, never the count.
- `--reject "No enabled managed skills"` names the empty branch as an unexpected text, in addition to the missing expectation. A library skill with no frontmatter `description` is silently dropped, which produces the same empty branch as an empty install.
- The repo-level symlink write is why this command must stay in a repo-scoped map: it does not touch user config, but it does read `$HOME/.agents/*`, append to `$HOME/.pi/agent/pi-debug.log`, and mutate `.pi/skills` in the primary checkout. Treat `HOME` as read-mostly, not isolated.
- `/toggle-skill` writes repo-level state (`.pi/disabled-skills` markers and symlinks) and is the one command here that can also write a user config file (`~/.pi/agent/third_extension_settings.json`, when a legacy `skillToggle` key is pruned), so it stays out of the map. In the helper's headless host it only notifies `toggle-skill requires interactive TUI mode`, which proves nothing about the toggle.
- `/cleanup-skills` is registered and notifies `Nothing to clean up. Run /reload to apply.` when there is nothing to remove, but it deletes both orphaned `.pi/skills` symlinks and disable markers with no matching skill, while its trailing `loadToggleState` recreates missing links. A run can therefore report `Nothing to clean up` and still have written. It stays out of the map for the same mutation reason.
