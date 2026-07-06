---
name: knowledge-wiki-summary
description: >
  Creates and manages wiki summary files: list stale summaries, create/overwrite summaries,
  insert/delete concept references. Use when building or updating wiki summaries.
---

# knowledge-wiki-summary

Creates and manages wiki summary files using the `wiki-summary.mjs` script.

## Dependencies

- `./wiki-summary.mjs` — the summary management script
- `./lib/` — local helper modules for this skill
- qmd knowledge base with Wiki/Summaries/ directory

## Path Resolution

Resolve every local path (`./*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/summary/`
- `./wiki-summary.mjs` resolves to `skills/knowledge-wiki/summary/wiki-summary.mjs`
- `./lib/` resolves inside the same skill directory

## Commands

### list-stale

Find source files whose summary is missing or whose content has changed:

```bash
node ./wiki-summary.mjs list-stale --base-path /path/to/knowledge-base
```

### create

Create (or overwrite) a summary file for a source path. Pipe the summary body via stdin:

```bash
node ./wiki-summary.mjs create "Posts/Foo.md" --tags "[ai, writing]" --base-path /path/to/knowledge-base < /tmp/body.md
```

### insert-concept

Add a [[Wiki/Concepts/...]] entry to the `## Key Concepts` section of a summary:

```bash
node ./wiki-summary.mjs insert-concept - --base-path /path/to/knowledge-base <<'EOF'
Wiki/Summaries/Posts/Foo.summary.md
feature-gating
Feature Gating
A technique to enable or disable features without deploying code
EOF
```

### delete-concept

Remove a [[Wiki/Concepts/...]] entry from the `## Key Concepts` section:

```bash
node ./wiki-summary.mjs delete-concept - --base-path /path/to/knowledge-base <<'EOF'
Wiki/Summaries/Posts/Foo.summary.md
feature-gating
EOF
```
