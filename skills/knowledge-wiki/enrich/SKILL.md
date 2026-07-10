---
name: knowledge-wiki-enrich
description: >
  Expand thin concept articles in the knowledge wiki using web search. Targets concepts
  with minimal prose assembled from few sources and supplements them with authoritative
  external information. Run after accumulating new concepts or when articles feel sparse.
---

# Knowledge Wiki Enrich

Find concept articles that are thin relative to their source material and expand them using web search. Each article is supplemented with authoritative external information integrated naturally into the existing prose.

## Dependencies

- `../cluster/candidates.mjs` — thin-concept detection (find-thin-concepts)
- `../state/wiki-index.mjs` — index management (upsert-concept)
- `./lib/` — local helper modules for this skill
- qmd knowledge base with `Wiki/Concepts/` directory

## Path Resolution

Resolve every local path (`../cluster/*.mjs`, `../state/*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/enrich/`
- `../cluster/candidates.mjs` resolves to `skills/knowledge-wiki/cluster/candidates.mjs`
- `../state/wiki-index.mjs` resolves to `skills/knowledge-wiki/state/wiki-index.mjs`
- `./lib/` resolves inside the same skill directory

## Steps

### 1. Establish the working directory

The knowledge base root is the Git repository root. Run `git rev-parse --show-toplevel` and store the result as `KNOWLEDGE_PATH`.

Use `KNOWLEDGE_PATH` for all subsequent steps. Append `--base-path "{KNOWLEDGE_PATH}"` to every `node ./...` command that accepts it.

### 2. Find thin concepts

Run:

```bash
node ../cluster/candidates.mjs find-thin-concepts --base-path "{KNOWLEDGE_PATH}"
```

Output is `{ "concepts": [...] }` — an array of concept file paths sorted by word count ascending, so the thinnest concepts come first. A concept is thin if it has fewer than 150 words in its body AND at most 2 entries in its `## Sources` section.

If the array is empty, print `No thin concepts found.` and stop.

### 3. Expand each thin concept

For each path in the `concepts` array:

1. Read the concept file. Note the display name from its `# Title` line, and derive the slug (basename without `.md`).
2. Use the WebSearch tool to search for the concept name. Choose 1–2 queries that would find authoritative reference material.
3. Fetch or read the most relevant search results.
4. Integrate new information into the article body: extend existing paragraphs or add new ones. Concept articles are written in English, but the concepts themselves may have originated from Chinese-language notes — use English terminology consistently when expanding. Use American English spelling (e.g. "organize" not "organise", "recognize" not "recognise"). Do not add content that contradicts existing text — flag contradictions in the print summary instead.
5. Write the updated file back to disk.
6. Derive a fresh one-line English description from the enriched article. Run:
   ```bash
   node ../state/wiki-index.mjs upsert-concept "{slug}" "{display name from step 1}" "{fresh one-line description}" --base-path "{KNOWLEDGE_PATH}"
   ```

Write in American English: use **-ize** not -ise, **-or** not -our, **-er** not -re. Do not modify frontmatter or the `## Sources` / `## Connected Concepts` sections.

### 4. Print summary

```
Knowledge Wiki Enrich

Expanded {N} concept(s):
  - {Display Name}
  - {Display Name}
  ...

Contradictions flagged:
  - {Display Name}: {brief description of conflict}
  [omit section if none]
```
