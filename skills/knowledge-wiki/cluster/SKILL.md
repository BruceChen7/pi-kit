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

- `../scripts/candidates.mjs` — candidate detection
- `../scripts/wiki-state.mjs` — dismissal and pruning
- `../scripts/lib/` — shared library
- qmd knowledge base with Wiki/Concepts/ directory

## Commands

### Find implied parent clusters

Detects groups of child concepts (e.g., `react-auth`, `react-routing`) that imply a missing or existing parent concept (`react`):

```bash
node ../scripts/candidates.mjs find-implied-parent-concepts --base-path /path/to/knowledge-base
```

### Dismiss a false positive

```bash
node ../scripts/wiki-state.mjs dismiss-pair knowledge-wiki-cluster \
  "Wiki/Concepts/parent.md" "Wiki/Concepts/child.md" \
  --base-path /path/to/knowledge-base
```

### Prune stale dismissals

Remove cluster dismissals where the child concept no longer exists:

```bash
node ../scripts/wiki-state.mjs prune-cluster-pairs --base-path /path/to/knowledge-base
```
