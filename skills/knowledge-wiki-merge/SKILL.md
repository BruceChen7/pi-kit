---
name: knowledge-wiki-merge
description: >
  Suggests concept merge candidates where two concepts share multiple sources, and updates
  wikilinks after merging. Use for deduplicating wiki concepts.
---

# knowledge-wiki-merge

Suggests concept merge candidates and updates backlinks after merging. Uses `candidates.mjs` and `wiki-backlinks.mjs`.

## Dependencies

- `scripts/wiki/candidates.mjs` — candidate detection
- `scripts/wiki/wiki-backlinks.mjs` — backlink updates after merge
- `scripts/wiki/lib/` — shared library
- qmd knowledge base with Wiki/Concepts/, Wiki/Summaries/ directories

## Workflow

### 1. Find merge candidates

Concepts that share 2+ source summaries may be candidates for merging:

```bash
node scripts/wiki/candidates.mjs find-shared-source-concepts --base-path /path/to/knowledge-base
```

### 2. Dismiss a false positive

If the pair should NOT be merged, dismiss it so it never appears again:

```bash
node scripts/wiki/wiki-state.mjs dismiss-pair knowledge-wiki-merge \
  "Wiki/Concepts/concept-a.md" "Wiki/Concepts/concept-b.md" \
  --base-path /path/to/knowledge-base
```

### 3. Update backlinks after merge

After merging concept files, update all wikilinks pointing to the secondary concept:

```bash
node scripts/wiki/wiki-backlinks.mjs update-after-merge \
  Wiki/Concepts/secondary.md \
  Wiki/Concepts/primary.md \
  "Primary Display Name" \
  --base-path /path/to/knowledge-base
```

### 4. Prune stale dismissals

Remove dismissed pairs where at least one concept file no longer exists:

```bash
node scripts/wiki/wiki-state.mjs prune-merge-pairs --base-path /path/to/knowledge-base
```
