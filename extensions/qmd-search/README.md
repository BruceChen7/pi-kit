# qmd-search

Query Markdown Documents — Hybrid search for markdown knowledge bases. Runs on-device with BM25 full-text search and optional vector + LLM reranking via [qmd](https://github.com/tobi/qmd).

## Quick start

```bash
# Install qmd globally (one-time)
npm install -g @tobilu/qmd

# Add a collection (your knowledge base)
qmd collection add ~/work/knowledge-base --name wiki

# Generate embeddings
qmd embed

# Search from anywhere
qmd search "your query"
```

Once qmd is installed, the extension automatically detects it at session startup and registers 4 tools + 3 slash commands.

## Workflow: daily cycle

A knowledge wiki repo follows a 5-step daily loop (source folders → summaries → concepts):

### 1. Write notes
Put `.md` files in source folders (`Notes/`, `Ideas/`, `Docs/`, etc.).
Each file should focus on one topic. Standard Markdown recommended.

### 2. Index
Run `qmd update` (full-text) + `qmd embed` (vectors) to index new content.
If you configured auto-indexing (see below), changes are picked up automatically within 3 seconds.

### 3. /knowledge-wiki-summary
Run this in Pi chat. It scans source files, computes content hashes (skips unchanged ones), and writes structured summaries (tags, abstract, key concepts) to `Wiki/Summaries/`.

### 4. /knowledge-wiki-concept
Run after summary. It reads `## Key Concepts` from each summary and creates/updates concept articles in `Wiki/Concepts/`, with backlinks to source summaries.

### 5. Review
Quick-check `Wiki/Summaries/`, `Wiki/Concepts/`, and `Wiki/index.md` for correctness.

### Periodic maintenance

| Scenario | Command | Frequency |
|----------|---------|-----------|
| 5+ new concepts accumulated | `/knowledge-wiki-synthesis` | weekly |
| Source files moved/deleted | `/knowledge-wiki-lint` | after reorganization |
| Thin concepts (< 150 字，≤ 2 sources) | `/knowledge-wiki-enrich` | monthly |
| Duplicate concepts found | `/knowledge-wiki-merge` | as needed |
| Too fragmented / missing parent topic | `/knowledge-wiki-cluster` | as needed |

### Searching

Agent uses `qmd_query` by default for knowledge base search. Falls back to `rg` (ripgrep) when qmd finds no results.

```text
> What does the wiki say about authentication patterns?
# Agent: qmd_query → reads top matches → answers
```

Manual search:

```text
rg "向量数据库" --type md
```

## Prerequisites

- `qmd` CLI (`npm install -g @tobilu/qmd`)
- At least one qmd collection configured (`qmd collection add ...`)
- (Optional) Vector embeddings (`qmd embed`) for semantic search

## Tools

The Pi agent can call these automatically when it needs knowledge base access. You trigger them indirectly by asking questions.

### `qmd_query` — Hybrid search across knowledge bases

Suggest the agent use this when you want semantic search across your indexed markdown files. The agent can pass a natural language query, typed sub-queries (lex/vec/hyde), collection filters, and reranking options.

```text
> Find documents about authentication patterns in my knowledge base
# Agent calls qmd_query internally and returns top results

> What does the wiki say about deployment strategies?
# Agent calls qmd_query, reads top matches, then answers
```

**Parameters the agent controls**: query, searches, collections, intent, limit, minScore, rerank

### `qmd_get` — Retrieve a single document by path or docid

The agent uses this after `qmd_query` to read the full content of a relevant document.

```text
> Read the document at docs/api.md
# Agent calls qmd_get and shows the content
```

**Parameters**: file, fromLine, maxLines, lineNumbers

### `qmd_multi_get` — Batch retrieve multiple documents

The agent uses this to read several files at once by glob pattern or comma-separated paths.

**Parameters**: pattern, maxBytes, maxLines, lineNumbers

### `qmd_status` — Check knowledge base health

```text
> Check my knowledge base status
# Agent calls qmd_status and reports configured collections and index health
```

**Parameters**: none

## Slash commands

These are manual commands you type in chat. They do not trigger LLM responses.

### `/qmd-update`

Re-index all collections. Scans the filesystem for new, changed, or removed files.

```text
/qmd-update
```

Displays a notification with the update summary.

### `/qmd-embed`

Generate or refresh vector embeddings for all indexed documents. Required for semantic search (`qmd query` / `qmd vsearch`).

```text
/qmd-embed
```

May take a while on large knowledge bases.

### `/qmd-doctor`

Diagnose the qmd installation: check runtime, sqlite-vec, embedding models, GPU probe, etc.

```text
/qmd-doctor
```

Use this first if tools are not appearing (qmd not detected correctly).

## Auto-indexing

If you configure knowledge base directories in `third_extension_settings.json`, the extension watches them with `fs.watch` and automatically runs `qmd update` when files change (3-second debounce).

### Configuration

Add to `.pi/third_extension_settings.json` (project-level) or `~/.pi/agent/third_extension_settings.json` (global):

```json
{
  "qmdSearch": {
    "knowledgeBases": {
      "my-wiki": {
        "path": "/path/to/my/wiki",
        "pattern": "**/*.md",
        "collections": ["wiki"]
      }
    }
  }
}
```

The `path` is watched for changes. `pattern` and `collections` are informational (qmd manages its own collection config via `qmd collection add`).

## Knowledge base skills

The 7 `knowledge-wiki-*` skills (registered in `skills/skills.txt`) provide wiki management workflows:

| Skill | What it does |
|-------|-------------|
| `knowledge-wiki-summary` | Create/update summary files from source documents |
| `knowledge-wiki-concept` | Create/manage wiki concept files |
| `knowledge-wiki-synthesis` | Create synthesis-type concepts from multiple summaries |
| `knowledge-wiki-merge` | Suggest concept merges + update backlinks |
| `knowledge-wiki-cluster` | Detect implied parent concepts |
| `knowledge-wiki-lint` | Wiki integrity checks (broken links, orphans) |
| `knowledge-wiki-state` | Manage wiki state and index |

All skills accept `--base-path <dir>` to point at the knowledge base root.

## What makes qmd-search different from cs_search

| | `cs_search` | `qmd_query` |
|---|---|---|
| What it searches | Source code in the repo | Markdown knowledge base files |
| Search backend | Boyter/cs (code search) | qmd (BM25 + vector + reranking) |
| Scope | Current repo | Any qmd collection (any directory) |
| Best for | Finding implementations, declarations | Semantic search across docs, notes, wiki |

## Tips

- **Install qmd first** — without it, no tools appear. Run `/qmd-doctor` to verify.
- **Run `/qmd-update`** after adding or changing files in your knowledge base.
- **Run `/qmd-embed`** once for semantic search; re-run after major content changes.
- **Tell the agent** "check my knowledge base" or "search my wiki" — it will use `qmd_query`.
- **After `qmd_query`**, the agent typically follows up with `qmd_get` to read full documents.
