---
description: Find stale wiki summaries and regenerate them with concept linking for the knowledge base
argument-hint: "[scope]"
---
# Wiki Summarize

Find source files in the wiki knowledge base whose summaries are missing or outdated (stale), then regenerate them with automatic concept linking.

Default to Chinese unless the user explicitly asks for another language.

## Scope

- **No argument** (`$1` is empty): run `list-stale` on the knowledge base and process all stale files
- **Single file path** (`$1` is a relative path like `Notes/Foo.md`): process only that specific file, even if it's not stale
- The knowledge base root is the current working directory (where `Wiki/` lives)

## Dependencies

Two skill scripts in this project's `.pi/skills/`:

| Script | Location | Commands used |
|--------|----------|---------------|
| `wiki-summary.mjs` | `.pi/skills/knowledge-wiki-summary/wiki-summary.mjs` | `list-stale`, `create`, `insert-concept` |
| `wiki-concept.mjs` | `.pi/skills/knowledge-wiki-concept/wiki-concept.mjs` | `create` (with `--tags` + stdin body), `insert-source` |
| `wiki-index.mjs` (state) | `.pi/skills/knowledge-wiki-state/wiki-index.mjs` | `upsert-summary` |

Resolve all relative paths (`./*.mjs`, `./lib/*.mjs`) relative to the source skill directory (same as `SKILL.md`). Pass `--base-path <cwd>` to every command.

## Workflow

### Phase 1: Discover stale files

```bash
node <path-to-wiki-summary.mjs> list-stale --base-path <cwd>
```

If the output JSON shows `"sources": []`, report "全部摘要已是最新 ✅" and stop.

Otherwise, list the stale files and proceed.

### Phase 2: Process each stale file

For each stale source file in the list (or the single file from `$1`):

1. **Read** the full source file content.

2. **Generate a summary body** — a concise Chinese paragraph (2-6 sentences) that captures the core topic, key insights, and structure of the note. Use specific terms and concepts from the content. Do NOT use generic templates like "关于...的笔记" or "关键洞察：...".

   **Line length:** Keep each line under 100 characters. When writing paragraphs, start a new line at each sentence boundary or comma to prevent ultra-long lines. The `create` command will preserve your line breaks.

3. **Create the summary**:

   ```bash
   node <path-to-wiki-summary.mjs> create "<source-path>" \
     --tags "[<comma-separated-tags>]" \
     --base-path <cwd> < <temp-body-file>
   ```

   Derive tags from the file's frontmatter `tags` field and the content topics. Use the same tag convention as existing summaries (e.g. `[cpp/learning, cpp/11]`, `[ebpf/learning]`).

4. **Update the index** — Register or update the summary entry in `Wiki/index.md`:

   Derive the summary's rel-path by stripping the `Wiki/Summaries/` prefix and the `.md` extension from the output path printed by the `create` command.

   Read the `## Summary` section from the summary file you just created (NOT the original source file), and generate a **one-line English description** (under 200 characters) from it.

   Then run:

   ```bash
   node <path-to-wiki-index.mjs> upsert-summary "{rel-path}" "{one-line description}" --base-path <cwd>
   ```

   The sumary file will have a path like `Wiki/Summaries/...` — derive `{rel-path}` by removing the `Wiki/Summaries/` prefix and the `.md` extension.

### Phase 3: Link concepts

After creating each summary, determine 1-3 relevant concepts based on the source content. Read `Wiki/Concepts/` to discover existing concept slugs and their scope.

For each relevant concept:

1. **Check if the concept slug already exists** in `Wiki/Concepts/<slug>.md`. If not, create it with a body describing the concept:

   Generate a body text (2-8 sentences) that covers the concept's definition, key ideas, and use cases. Structure it with one or more `##` sections as appropriate (e.g. `## Core Concepts`, `## How It Works`, `## Use Cases`). Write the body in Chinese.

   Write the body to a temp file, then create the concept by piping it through stdin with `--tags`:

   ```bash
   node <path-to-wiki-concept.mjs> create <slug> "<display-name>" \
     --tags "[<comma-separated-tags>]" \
     --base-path <cwd> < /tmp/concept-body-$$.md
   ```

   Derive tags from the concept's domain (e.g. `[concurrency, memory-model, c-cpp]`, `[distributed-systems, hashing]`, `[data-structure, cryptography]`). Use the same tag convention as existing concepts in `Wiki/Concepts/`.

   If the concept already exists (file exists error), skip creation and proceed to step 2.

2. **Insert concept link into the summary** (summary → concept direction):

   ```bash
   node <path-to-wiki-summary.mjs> insert-concept - \
     --base-path <cwd> <<'EOF'
   Wiki/Summaries/<summary-rel-path>
   <slug>
   <display-name>
   <brief description of what this source says about the concept>
   EOF
   ```

3. **Insert source link into the concept** (concept → summary direction):

   ```bash
   node <path-to-wiki-concept.mjs> insert-source <slug> \
     "Wiki/Summaries/<summary-path-without-ext>" \
     --base-path <cwd>
   ```

### Phase 4: Verify

After processing all files, run `list-stale` again:

```bash
node <path-to-wiki-summary.mjs> list-stale --base-path <cwd>
```

Confirm the output is `"sources": []`.

### Final output format

End your response with a single JSON object on its own line. Use this exact schema:

```json
{
  "ok": true,
  "done": "Phase 1: N stale files. Phase 2: N summaries created. Phase 3: N concepts linked.",
  "summaries": [
    "Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-06.summary.md",
    "Wiki/Summaries/Calendar/DailyNotes/2026/2026-07-08.summary.md"
  ]
}
```

- `summaries`: array of **relative paths** to the summary files you created or updated (under `Wiki/Summaries/`). If nothing was created, use an empty array `[]`.
- Include ALL summary files created — not a truncated list.
- On failure, omit `summaries` and use `"done"` to describe the failure.

## Concept matching guidelines

- Read the source content and identify thematic categories that match existing concepts
- The existing concept directory (`Wiki/Concepts/`) contains broad categories like `c-cpp`, `ebpf`, `linux-kernel`, `agent-patterns`, `performance`, `rust`, `dev-tools`, `networking`, etc.
- Prefer existing concepts over creating new ones. Only create a new concept when the source content clearly introduces a thematic category not yet covered
- Concepts can be more specific than the existing set, but should remain as reusable thematic categories, not one-off entries per source file
- 1-3 concepts per source file is the sweet spot
- Avoid linking to concepts that are trivially related — every link should add navigational value

## Notes

- The path to `wiki-summary.mjs` is `.pi/skills/knowledge-wiki-summary/wiki-summary.mjs`
- The path to `wiki-concept.mjs` is `.pi/skills/knowledge-wiki-concept/wiki-concept.mjs`
- The path to `wiki-index.mjs` (state) is `.pi/skills/knowledge-wiki-state/wiki-index.mjs`
- Always pass `--base-path` as the current working directory so the scripts resolve the knowledge base root correctly
- Use `--tags` with the bracket format like `[tag1, tag2]` (must be valid JSON array)
- The `insert-concept` command reads all fields from stdin when `-` is passed as the first argument, with one field per line: summary-rel-path, slug, display-name, description (the last field spans the rest and is trimmed)
- For `insert-source`, the summary path is without the `.summary.md` suffix (e.g. `Wiki/Summaries/Notes/Foo.summary`)
- For `wiki-concept.mjs create`: pipe body content via stdin to create a fully populated concept file. Without stdin, it creates a skeleton (frontmatter + title + empty Sources). Use `--tags` to populate the frontmatter tags field, e.g. `--tags "[concurrency, memory-model]"`.
