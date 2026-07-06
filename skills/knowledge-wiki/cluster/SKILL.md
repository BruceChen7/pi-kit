---
name: knowledge-wiki-cluster
description: >
  Suggests parent-concept clusters where multiple child concepts imply a missing parent
  concept. Uses candidates.mjs find-implied-parent-concepts to detect groups like
  react-auth + react-routing implying react. Use when maintaining wiki concept hierarchies.
---

# knowledge-wiki-cluster

Suggests parent-concept clusters where multiple child concepts imply a missing parent concept. Uses `candidates.mjs find-implied-parent-concepts`.

## Dependencies

- `./candidates.mjs` — candidate detection
- `./wiki-state.mjs` — dismissal and pruning
- `./lib/` — local helper modules for this skill
- qmd knowledge base with Wiki/Concepts/ directory

## Path Resolution

Resolve every local path (`./*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/cluster/`
- `./candidates.mjs` resolves to `skills/knowledge-wiki/cluster/candidates.mjs`
- `./wiki-state.mjs` resolves to `skills/knowledge-wiki/cluster/wiki-state.mjs`
- `./lib/` resolves inside the same skill directory

## Commands

### Find implied parent clusters

Detects groups of child concepts (e.g., `react-auth`, `react-routing`) that imply a missing or existing parent concept (`react`):

```bash
node ./candidates.mjs find-implied-parent-concepts --base-path /path/to/knowledge-base
```

### Dismiss a false positive

```bash
node ./wiki-state.mjs dismiss-pair knowledge-wiki-cluster \
  "Wiki/Concepts/parent.md" "Wiki/Concepts/child.md" \
  --base-path /path/to/knowledge-base
```

### Prune stale dismissals

Remove cluster dismissals where the child concept no longer exists:

```bash
node ./wiki-state.mjs prune-cluster-pairs --base-path /path/to/knowledge-base
```
