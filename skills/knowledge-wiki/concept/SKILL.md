---
name: knowledge-wiki-concept
description: >
  Creates and manages wiki concept files — create skeleton concepts, insert/delete source
  links and connected concept links. Use when building or maintaining wiki knowledge base
  concepts.
---

# knowledge-wiki-concept

Creates and manages wiki concept files using the `wiki-concept.mjs` script.

## Dependencies

- `./wiki-concept.mjs` — the concept management script
- `./lib/` — local helper modules for this skill
- qmd knowledge base with Wiki/Concepts/ directory

## Path Resolution

Resolve every local path (`./*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/concept/`
- `./wiki-concept.mjs` resolves to `skills/knowledge-wiki/concept/wiki-concept.mjs`
- `./lib/` resolves inside the same skill directory

## Commands

### create

Create a skeleton concept file:

```bash
node ./wiki-concept.mjs create <slug> "<display-name>" --base-path /path/to/knowledge-base
```

Optional: `--type <Concept|Synthesis>` (default Concept), `--icon <note|notepad>` (default note).

### insert-source

Append a source link to the `## Sources` section:

```bash
node ./wiki-concept.mjs insert-source <slug> "Wiki/Summaries/Posts/Foo.summary" --base-path /path/to/knowledge-base
```

### delete-source

Remove a source link from the `## Sources` section:

```bash
node ./wiki-concept.mjs delete-source <slug> "Wiki/Summaries/Posts/Foo.summary" --base-path /path/to/knowledge-base
```

### insert-connected-concept

Add a connected concept link to the `## Connected Concepts` section:

```bash
node ./wiki-concept.mjs insert-connected-concept <slug> <linked-slug> "<display-name>" --base-path /path/to/knowledge-base
```

### delete-connected-concept

Remove a connected concept link:

```bash
node ./wiki-concept.mjs delete-connected-concept <slug> <linked-slug> --base-path /path/to/knowledge-base
```
