---
name: knowledge-wiki-enrich
description: >
  Finds wiki files and index entries needing attention: unsummarized sources, missing index
  entries, and stale summaries. Use during wiki maintenance to identify gaps and sync the
  index.
---

# knowledge-wiki-enrich

Finds wiki files and index entries that need attention: unsummarized sources, missing index entries, and stale summaries. Uses `wiki-summary.mjs list-stale` and `wiki-index.mjs find-missing-*`.

## Dependencies

- `../scripts/wiki-summary.mjs` — staleness detection
- `../scripts/wiki-index.mjs` — index gap detection
- `../scripts/lib/` — shared library
- qmd knowledge base with Wiki/ and source directories

## Commands

### Find stale and missing summaries

```bash
node ../scripts/wiki-summary.mjs list-stale --base-path /path/to/knowledge-base
```

Output: `{ "sources": ["rel/path.md", ...] }` — source files whose summary is missing or whose content hash has changed.

### Find missing index entries

```bash
# Summary files on disk that have no entry in Wiki/index.md
node ../scripts/wiki-index.mjs find-missing-summaries --base-path /path/to/knowledge-base

# Concept files on disk that have no entry in Wiki/index.md
node ../scripts/wiki-index.mjs find-missing-concepts --base-path /path/to/knowledge-base

# Dead index entries where the file no longer exists
node ../scripts/wiki-index.mjs delete-dead-links --base-path /path/to/knowledge-base
```

### Sort index

```bash
node ../scripts/wiki-index.mjs sort --base-path /path/to/knowledge-base
```

## Workflow

1. Run `list-stale` to find source files needing new/updated summaries
2. Create summaries with `knowledge-wiki-summary` skill
3. Run `find-missing-summaries` / `find-missing-concepts` to sync index
4. Add missing entries with `knowledge-wiki-state` skill (`wiki-index.mjs upsert-*`)
5. Run `delete-dead-links` and `sort` to clean up the index
