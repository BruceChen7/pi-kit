# Skill toggle

The skill-toggle plugin enables and disables managed skills. `/disabled-skills` prints the managed skills that are currently enabled. The readout has one write side effect: its handler calls `loadToggleState`, which best-effort creates missing symlinks under `<cwd>/.pi/skills` before it formats the list.

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

- The names come from the home skill library intersected with the enabled set. Five names are always excluded and `<cwd>/.pi/disabled-skills` markers exclude more, so assert the prefix, never the count.
- `--reject "No enabled managed skills"` turns the empty branch into a named failure instead of a bare missing expectation. A library skill with no frontmatter `description` is silently dropped, which produces the same empty branch as an empty install.
- The repo-level symlink write is why this command must stay in a repo-scoped map: it needs no isolated `HOME`, but it does mutate `<cwd>/.pi/skills`.
- `/toggle-skill` writes repo-level state (`<cwd>/.pi/disabled-skills` markers and symlinks) and needs an interactive TUI, so it stays out of the map.
