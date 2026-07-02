---
name: knowledge-wiki-synthesis
description: >
  Creates synthesis-type wiki concepts — higher-level abstractions derived from multiple
  source summaries. Uses wiki-concept.mjs with --type Synthesis. Run after processing
  source summaries to create cross-cutting concept views.
---

# knowledge-wiki-synthesis

Creates synthesis-type wiki concepts — higher-level abstractions derived from multiple source summaries. Uses `wiki-concept.mjs` with `--type Synthesis`.

## Dependencies

- `../scripts/wiki-concept.mjs` — the concept management script
- `../scripts/wiki-state.mjs` — for tracking unprocessed summaries
- `../scripts/lib/` — shared library
- qmd knowledge base with Wiki/Concepts/ and Wiki/Summaries/ directories

## Workflow

### 1. Find unprocessed summaries

Check which summaries have been created/updated since the last synthesis run:

```bash
node ../scripts/wiki-state.mjs find-unprocessed-summaries knowledge-wiki-synthesis --base-path /path/to/knowledge-base
```

### 2. Create the synthesis concept

Use `wiki-concept.mjs create` with `--type Synthesis`:

```bash
node ../scripts/wiki-concept.mjs create <slug> "<display-name>" --type Synthesis --icon notepad --base-path /path/to/knowledge-base
```

### 3. Insert synthesized content

Add source links to the concept. The body should be written by the LLM based on analysis of the source summaries.

### 4. Record the run timestamp

```bash
node ../scripts/wiki-state.mjs set-last-run knowledge-wiki-synthesis --base-path /path/to/knowledge-base
```
