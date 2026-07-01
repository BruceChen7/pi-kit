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

## Workflow: create → update → query

### 1. Prepare your wiki directory

Put markdown files anywhere you like. A typical wiki looks like:

```
~/work/my-wiki/
├── Wiki/
│   ├── Concepts/
│   │   └── feature-gating.md
│   ├── Summaries/
│   │   └── Posts/
│   │       └── my-post.summary.md
│   └── index.md
└── Posts/
    └── my-post.md
```

You can also start simpler — just a flat folder of `.md` files. The `Wiki/` structure is optional and only needed if you use the `knowledge-wiki-*` skills.

### 2. Register the collection with qmd

```bash
# Replace with your actual path
qmd collection add ~/work/my-wiki --name my-wiki
```

Verify it shows up:

```bash
qmd collection list
```

### 3. Index the content

```bash
# Full-text index (fast)
qmd update

# Vector embeddings for semantic search (slower, one-time)
qmd embed
```

### 4. (Optional) Register for auto-indexing

Add the directory to your Pi config so the extension watches for changes:

```json
// .pi/third_extension_settings.json
{
  "qmdSearch": {
    "knowledgeBases": {
      "my-wiki": {
        "path": "/Users/you/work/my-wiki",
        "pattern": "**/*.md"
      }
    }
  }
}
```

After this, every time you save a `.md` file in `~/work/my-wiki/`, the extension automatically runs `qmd update` within 3 seconds.

### 5. Query from Pi chat

Once indexed, the agent will use `qmd_query` whenever you ask wiki-related questions:

```text
> Search my wiki for authentication patterns
# Agent runs qmd_query → returns ranked results → reads top matches → answers

> What does the wiki say about deployment?
# Agent runs qmd_query → finds relevant docs → answers from content

> Check my knowledge base status
# Agent runs qmd_status → shows collection health
```

You can also trigger an explicit update manually:

```text
/qmd-update
```

### 6. Enrich the wiki (optional)

Use the `knowledge-wiki-*` skills to build a proper wiki with summaries, concepts, and cross-links:

```bash
# Activate the skills
/skill:knowledge-wiki-summary
/skill:knowledge-wiki-concept
```

Then ask the agent to create summaries or concepts from your source documents.

### Example: end-to-end session

```text
# 1. Prepare
$ mkdir -p ~/work/my-wiki/Posts
$ echo "# Hello World" > ~/work/my-wiki/Posts/intro.md

# 2. Register & index
$ qmd collection add ~/work/my-wiki --name my-wiki
$ qmd update
$ qmd embed

# 3. In Pi chat
> /qmd-doctor
> Search my wiki for introduction
> /qmd-update

# 4. Add a new file
$ echo "# Authentication" > ~/work/my-wiki/Posts/auth.md

# 5. (Auto-indexed if configured) or manual
> /qmd-update
> What does the wiki say about authentication?
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
