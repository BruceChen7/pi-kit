---
name: knowledge-wiki-lint
description: >
  Wiki integrity checking: broken concept links, broken summary links, orphan files,
  ungrounded concepts, self-links, and duplicate links. Use to audit wiki health.
---

# knowledge-wiki-lint

Wiki integrity checking. Uses `wiki-lint.mjs` to audit the wiki for broken links, orphan files, and structural issues.

## Dependencies

- `../scripts/wiki-lint.mjs` — the lint script
- `../scripts/lib/` — shared library
- qmd knowledge base with Wiki/ directory

## Commands

All commands output JSON to stdout.

```bash
node ../scripts/wiki-lint.mjs find-broken-concept-links --base-path /path/to/knowledge-base
node ../scripts/wiki-lint.mjs find-broken-summary-links --base-path /path/to/knowledge-base
node ../scripts/wiki-lint.mjs find-orphan-concepts --base-path /path/to/knowledge-base
node ../scripts/wiki-lint.mjs find-orphan-summaries --base-path /path/to/knowledge-base
node ../scripts/wiki-lint.mjs find-ungrounded-concepts --base-path /path/to/knowledge-base
node ../scripts/wiki-lint.mjs find-self-links --base-path /path/to/knowledge-base
node ../scripts/wiki-lint.mjs find-duplicate-concept-links --base-path /path/to/knowledge-base
```

## Checks

| subcommand | what it finds |
|---|---|
| `find-broken-concept-links` | Concept wikilinks to files that don't exist |
| `find-broken-summary-links` | Summary wikilinks to missing concept files |
| `find-orphan-concepts` | Concept files with zero inbound links |
| `find-orphan-summaries` | Summary files whose source document is missing |
| `find-ungrounded-concepts` | Concepts with no valid source summaries |
| `find-self-links` | Concepts that link to themselves in Connected Concepts |
| `find-duplicate-concept-links` | Summaries linking the same concept more than once |
