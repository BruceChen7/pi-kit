---
name: knowledge-wiki-state
description: >
  Manages wiki state: .state.json read/write, index maintenance (upsert/delete/sort/find
  gaps), and processed-summary tracking. Utility skill used by other knowledge-wiki skills.
---

# knowledge-wiki-state

Manages wiki state: reads/writes Wiki/.state.json, index maintenance, and processed-summary tracking. Used as a utility by other knowledge-wiki skills.

## Dependencies

- `scripts/wiki/wiki-state.mjs` — state management
- `scripts/wiki/wiki-index.mjs` — index management
- `scripts/wiki/lib/` — shared library
- qmd knowledge base with Wiki/ directory

## Commands

### State Management

```bash
# Find summaries not yet processed by a skill
node scripts/wiki/wiki-state.mjs find-unprocessed-summaries knowledge-wiki-concept --base-path /path/to/knowledge-base
node scripts/wiki/wiki-state.mjs find-unprocessed-summaries knowledge-wiki-synthesis --base-path /path/to/knowledge-base

# Record when a skill last ran
node scripts/wiki/wiki-state.mjs set-last-run knowledge-wiki-concept --base-path /path/to/knowledge-base
node scripts/wiki/wiki-state.mjs set-last-run knowledge-wiki-synthesis --base-path /path/to/knowledge-base
```

### Index Management (wiki-index.mjs)

```bash
# Sort index entries
node scripts/wiki/wiki-index.mjs sort --base-path /path/to/knowledge-base

# Read current entries
node scripts/wiki/wiki-index.mjs read-concepts --base-path /path/to/knowledge-base
node scripts/wiki/wiki-index.mjs read-summaries --base-path /path/to/knowledge-base

# Insert/update/delete entries
node scripts/wiki/wiki-index.mjs upsert-concept <slug> "<display-name>" "<description>" --base-path /path/to/knowledge-base
node scripts/wiki/wiki-index.mjs delete-concept <slug> --base-path /path/to/knowledge-base
node scripts/wiki/wiki-index.mjs upsert-summary "<rel-path>" "<description>" --base-path /path/to/knowledge-base
node scripts/wiki/wiki-index.mjs delete-summary "<rel-path>" --base-path /path/to/knowledge-base

# Find sync gaps
node scripts/wiki/wiki-index.mjs find-missing-summaries --base-path /path/to/knowledge-base
node scripts/wiki/wiki-index.mjs find-missing-concepts --base-path /path/to/knowledge-base
node scripts/wiki/wiki-index.mjs delete-dead-links --base-path /path/to/knowledge-base
```
