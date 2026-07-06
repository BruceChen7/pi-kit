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

- `./wiki-concept.mjs` — the concept management script
- `./wiki-state.mjs` — for tracking unprocessed summaries
- `./lib/` — local helper modules for this skill
- qmd knowledge base with Wiki/Concepts/ and Wiki/Summaries/ directories

## Path Resolution

Resolve every local path (`./*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/synthesis/`
- `./wiki-concept.mjs` resolves to `skills/knowledge-wiki/synthesis/wiki-concept.mjs`
- `./wiki-state.mjs` resolves to `skills/knowledge-wiki/synthesis/wiki-state.mjs`
- `./lib/` resolves inside the same skill directory

## Workflow

### 1. Find unprocessed summaries

Check which summaries have been created/updated since the last synthesis run:

```bash
node ./wiki-state.mjs find-unprocessed-summaries knowledge-wiki-synthesis --base-path /path/to/knowledge-base
```

### 2. Create the synthesis concept

Use `wiki-concept.mjs create` with `--type Synthesis`:

```bash
node ./wiki-concept.mjs create <slug> "<display-name>" --type Synthesis --icon notepad --base-path /path/to/knowledge-base
```

### 3. Insert synthesized content

Add source links to the concept. The body should be written by the LLM based on analysis of the source summaries.

### 4. Record the run timestamp

```bash
node ./wiki-state.mjs set-last-run knowledge-wiki-synthesis --base-path /path/to/knowledge-base
```
