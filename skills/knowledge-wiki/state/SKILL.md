---
name: knowledge-wiki-state
description: >
  Manages wiki state: .state.json read/write, index maintenance (upsert/delete/sort/find
  gaps), and processed-summary tracking. Utility skill used by other knowledge-wiki skills.
---

# knowledge-wiki-state

Manages wiki state: reads/writes Wiki/.state.json, index maintenance, and processed-summary tracking. Used as a utility by other knowledge-wiki skills.

## Dependencies

- `./wiki-state.mjs` — state management
- `./wiki-index.mjs` — index management
- `./lib/` — local helper modules for this skill
- qmd knowledge base with Wiki/ directory

## Path Resolution

Resolve every local path (`./*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/state/`
- `./wiki-state.mjs` resolves to `skills/knowledge-wiki/state/wiki-state.mjs`
- `./wiki-index.mjs` resolves to `skills/knowledge-wiki/state/wiki-index.mjs`
- `./lib/` resolves inside the same skill directory

## Commands

### State Management

```bash
# Find summaries not yet processed by a skill
node ./wiki-state.mjs find-unprocessed-summaries knowledge-wiki-concept --base-path /path/to/knowledge-base
node ./wiki-state.mjs find-unprocessed-summaries knowledge-wiki-synthesis --base-path /path/to/knowledge-base

# Record when a skill last ran
node ./wiki-state.mjs set-last-run knowledge-wiki-concept --base-path /path/to/knowledge-base
node ./wiki-state.mjs set-last-run knowledge-wiki-synthesis --base-path /path/to/knowledge-base
```

### Index Management (wiki-index.mjs)

```bash
# Sort index entries
node ./wiki-index.mjs sort --base-path /path/to/knowledge-base

# Read current entries
node ./wiki-index.mjs read-concepts --base-path /path/to/knowledge-base
node ./wiki-index.mjs read-summaries --base-path /path/to/knowledge-base

# Insert/update/delete entries
node ./wiki-index.mjs upsert-concept <slug> "<display-name>" "<description>" --base-path /path/to/knowledge-base
node ./wiki-index.mjs delete-concept <slug> --base-path /path/to/knowledge-base
node ./wiki-index.mjs upsert-summary "<rel-path>" "<description>" --base-path /path/to/knowledge-base
node ./wiki-index.mjs delete-summary "<rel-path>" --base-path /path/to/knowledge-base

# Find sync gaps
node ./wiki-index.mjs find-missing-summaries --base-path /path/to/knowledge-base
node ./wiki-index.mjs find-missing-concepts --base-path /path/to/knowledge-base
node ./wiki-index.mjs delete-dead-links --base-path /path/to/knowledge-base
```
