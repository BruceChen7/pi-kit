---
name: knowledge-wiki-summary
description: >
  Generate or refresh wiki summaries for knowledge base markdown files. Use when the user
  wants to summarize notes, update the wiki, compile stale summaries, or process new
  knowledge base files into Wiki/Summaries.
disable-model-invocation: true
---

# Knowledge Wiki Summary

Batch process all stale or new knowledge base files and write their wiki summaries. Incremental — only processes files whose content has changed since the last summary was written.

## Dependencies

- `./wiki-summary.mjs` — the summary management script
- `../state/wiki-index.mjs` — the index management script
- `./lib/` — local helper modules for this skill
- qmd knowledge base with `Wiki/Summaries/` directory

## Path Resolution

Resolve every local path (`./*.mjs`, `../state/*.mjs`, `./lib/*.mjs`) relative to the source skill directory that contains this `SKILL.md`.

Do not resolve these paths relative to `~/.pi/skills/...` or the current working directory.

Example for this skill:

- source skill directory: `skills/knowledge-wiki/summary/`
- `./wiki-summary.mjs` resolves to `skills/knowledge-wiki/summary/wiki-summary.mjs`
- `../state/wiki-index.mjs` resolves to `skills/knowledge-wiki/state/wiki-index.mjs`
- `./lib/` resolves inside the same skill directory

## Steps

### 1. Establish the working directory

The knowledge base root is the Git repository root. Run `git rev-parse --show-toplevel` and store the result as `KNOWLEDGE_PATH`.

Use `KNOWLEDGE_PATH` for all subsequent steps. Append `--base-path "{KNOWLEDGE_PATH}"` to every `node ./...` command that accepts it.

### 2. Find files that need summarizing

Run:

```bash
node ./wiki-summary.mjs list-stale --base-path "{KNOWLEDGE_PATH}"
```

Output format:

```json
{ "sources": ["Posts/Buy Me a Coffee.md", ...] }
```

Each entry is a source file path relative to `KNOWLEDGE_PATH`.

If `sources` is empty, print `Nothing to summarize.` and stop.

### 3. Process each file

For each entry in `sources`, run the following sub-steps in order.

---

#### 3a. Read the source file

Read the full source file using the Read tool. If the file is longer than 2000 lines, read it in chunks using `offset` and `limit` parameters (e.g. read offset=1 limit=2000, then offset=2001, etc.) until you have the complete content.

---

#### 3b. Generate the summary content

**Language:** Notes in this knowledge base are predominantly in Chinese. Write the title, summary prose, and key points in the same language as the source document. If the source is in Mandarin, write in Mandarin. If in Cantonese, write in Cantonese. If the source language is ambiguous or mixed (e.g. Chinese text with English technical terms), default to Chinese. Only write in English when the source is clearly and entirely in English. Section headers (`## Summary`, `## Key Concepts`) stay in English regardless of source language. When writing in English, use American English spelling (e.g. "realize" not "realise", "organize" not "organise").

Generate the following content from the source document:

1. **`tags`** — 3–8 lowercase English tags based on content, comma-separated

2. **Title** — infer from content or filename, in source language

3. **`## Summary`** — 2–4 sentences in source language summarizing the document's main subject, argument, or purpose

4. **`## Key Concepts`** — a bulleted list of 3–8 key concepts this source covers, each formatted as:
   ```
   - [[Wiki/Concepts/{concept-slug}|{Display Name}]] — {brief description in source language}
   ```
   - Concept slugs are always lowercase English kebab-case regardless of source language.
   - Display Name is the correctly-cased human-readable title **always in English**, regardless of source language (e.g. `[[Wiki/Concepts/restful-api|RESTful API]]`). Infer the English concept name from the source text — don't derive it mechanically from the slug.
   - Concept files may not exist yet — broken links are acceptable here.

5. **`## Notable Details`** — any specific facts, figures, quotes, findings, or techniques worth preserving verbatim, in source language

---

#### 3c. Write the summary file

First, generate a unique temp file path:

```bash
mktemp /tmp/wiki_summary_body.XXXXXX
```

The command prints the path (e.g. `/tmp/wiki_summary_body.aB3xYz`). Store this as `{tmpfile}`.

Use the Write tool to write the generated content to `{tmpfile}`:

```
# Title

## Summary
...

## Key Concepts
- [[Wiki/Concepts/example-concept|Example Concept]] — brief description

## Notable Details
...
```

Then pipe it into `create` and clean up:

```bash
node ./wiki-summary.mjs create "{source_path}" --tags "[tag1, tag2, tag3]" --base-path "{KNOWLEDGE_PATH}" < "{tmpfile}" && rm "{tmpfile}"
```

The script writes all frontmatter (`source`, `hash`, `summarized_at`, `type`, `_icon`) and the `## Backlinks` section automatically, then prints the summary file path. Store this as `{summary_path}`.

If `create` exits with an error (e.g. source file not found), do not proceed. Run `ls "{KNOWLEDGE_PATH}/$(dirname "{source_path}")"` to find the exact filename on disk, then retry with the correct path.

---

#### 3d. Update the index

Derive the summary's rel-path by stripping the `Wiki/Summaries/` prefix and the `.md` extension from `{summary_path}`.

Example: `Wiki/Summaries/Posts/Buy Me a Coffee.summary.md` → `Posts/Buy Me a Coffee.summary`

Read the summary file you just generated at `{summary_path}`. Extract a **one-line English description** (under 200 characters) from its `## Summary` section. **Do NOT re-read the original source file** — use only the summary file content.

Then run:

```bash
node ../state/wiki-index.mjs upsert-summary "{rel-path}" "{one-line description}" --base-path "{KNOWLEDGE_PATH}"
```

If the one-line description exceeds 200 characters, truncate it at a word boundary and append "…". The `upsert-summary` command itself also truncates, but it's better to be concise upfront.

---

### 4. Print summary

```
Summarized {N} file(s):
  - {source_path} → {summary_path}
  - {source_path} → {summary_path}
  ...
```

## Additional Commands

These are available for manual maintenance or use by other skills.

### insert-concept

Add a `[[Wiki/Concepts/...]]` entry to the `## Key Concepts` section of a summary:

```bash
node ./wiki-summary.mjs insert-concept - --base-path {KNOWLEDGE_PATH} <<'EOF'
Wiki/Summaries/Posts/Foo.summary.md
feature-gating
Feature Gating
A technique to enable or disable features without deploying code
EOF
```

### delete-concept

Remove a `[[Wiki/Concepts/...]]` entry from the `## Key Concepts` section:

```bash
node ./wiki-summary.mjs delete-concept - --base-path {KNOWLEDGE_PATH} <<'EOF'
Wiki/Summaries/Posts/Foo.summary.md
feature-gating
EOF
```
