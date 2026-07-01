# knowledge-wiki-cluster

Suggests parent-concept clusters where multiple child concepts imply a missing parent concept. Uses `candidates.mjs find-implied-parent-concepts`.

## Dependencies

- `scripts/wiki/candidates.mjs` — candidate detection
- `scripts/wiki/wiki-state.mjs` — dismissal and pruning
- `scripts/wiki/lib/` — shared library
- qmd knowledge base with Wiki/Concepts/ directory

## Commands

### Find implied parent clusters

Detects groups of child concepts (e.g., `react-auth`, `react-routing`) that imply a missing or existing parent concept (`react`):

```bash
node scripts/wiki/candidates.mjs find-implied-parent-concepts --base-path /path/to/knowledge-base
```

### Dismiss a false positive

```bash
node scripts/wiki/wiki-state.mjs dismiss-pair knowledge-wiki-cluster \
  "Wiki/Concepts/parent.md" "Wiki/Concepts/child.md" \
  --base-path /path/to/knowledge-base
```

### Prune stale dismissals

Remove cluster dismissals where the child concept no longer exists:

```bash
node scripts/wiki/wiki-state.mjs prune-cluster-pairs --base-path /path/to/knowledge-base
```
