---
name: knowledge-wiki-merge
description: >
  Suggests concept merge candidates where two concepts share multiple sources, and updates
  wikilinks after merging. Use for deduplicating wiki concepts.
---

# knowledge-wiki-merge

Suggests concept merge candidates and updates backlinks after merging. Uses `candidates.mjs` and `wiki-backlinks.mjs`.

## Dependencies

- `./candidates.mjs` — candidate detection
- `./wiki-state.mjs` — dismissal and pruning
- `./wiki-backlinks.mjs` — backlink updates after merge
- `./lib/` — local helper modules for this skill
- qmd knowledge base with Wiki/Concepts/, Wiki/Summaries/ directories

## Path Resolution

Resolve every local path (`./*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/merge/`
- `./candidates.mjs` resolves to `skills/knowledge-wiki/merge/candidates.mjs`
- `./wiki-state.mjs` resolves to `skills/knowledge-wiki/merge/wiki-state.mjs`
- `./wiki-backlinks.mjs` resolves to `skills/knowledge-wiki/merge/wiki-backlinks.mjs`
- `./lib/` resolves inside the same skill directory

## Workflow

### 1. Find merge candidates

Concepts that share 2+ source summaries may be candidates for merging:

```bash
node ./candidates.mjs find-shared-source-concepts --base-path /path/to/knowledge-base
```

### 2. Dismiss a false positive

If the pair should NOT be merged, dismiss it so it never appears again:

```bash
node ./wiki-state.mjs dismiss-pair knowledge-wiki-merge \
  "Wiki/Concepts/concept-a.md" "Wiki/Concepts/concept-b.md" \
  --base-path /path/to/knowledge-base
```

### 3. Update backlinks after merge

After merging concept files, update all wikilinks pointing to the secondary concept:

```bash
node ./wiki-backlinks.mjs update-after-merge \
  Wiki/Concepts/secondary.md \
  Wiki/Concepts/primary.md \
  "Primary Display Name" \
  --base-path /path/to/knowledge-base
```

### 4. Prune stale dismissals

Remove dismissed pairs where at least one concept file no longer exists:

```bash
node ./wiki-state.mjs prune-merge-pairs --base-path /path/to/knowledge-base
```
