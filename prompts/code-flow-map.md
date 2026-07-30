---
description: Map a code flow with Visual Artifact, key data structures, blast radius, and grill-me checks
argument-hint: "[flow/module/question]"
---
Map the existing code flow for: ${@:-<ask me which flow/module/question first>}

Generate a Visual Artifact code-flow learning map via the `create_visual_artifact` tool from
`extensions/visual-artifact`. This is for understanding existing code, not implementing changes.

If no concrete flow/module/question was provided, ask me exactly one scope question and wait. Do not
start broad repo exploration until I answer.

## Mission

Help me rebuild a working mental model of one code path:

- What triggers it and where it enters the system
- Which modules/functions/types participate
- Which data structures and state transitions matter
- Which IO boundaries, side effects, adapters, env/config, clocks, or globals are involved
- What might break if this flow changes
- Where tests or verification hooks already exist
- What I should be grilled on to prove I understand it

## Investigation phase

Use source evidence first. Prefer `cs_search` to locate likely implementations, then `read` the best
files in full context. Use `rg` for exact identifiers, callers, tests, config keys, and error strings.

Gather these facts before generating the artifact:

1. **Entry points** — commands, handlers, routes, event listeners, scheduled jobs, hooks, or public
   APIs that start the flow.
2. **Main control flow** — important branches, validation, transformations, retries, fallbacks,
   early returns, and error paths.
3. **Key data structures** — domain types, DTOs, schemas, config objects, persisted records,
   in-memory state, and ownership/lifecycle rules.
4. **Boundaries and side effects** — filesystem, git, network, subprocesses, model/provider calls,
   TUI/RPC/UI interactions, databases, caches, env vars, clocks, and global state.
5. **Blast radius** — callers, downstream consumers, tests, docs, settings, package exports,
   generated files, migrations, and compatibility contracts that depend on this flow.
6. **Tests and verification** — existing test files, smoke tests, scripts, manual commands, and
   missing coverage.
7. **Gotchas** — non-obvious coupling, ordering requirements, implicit invariants, race conditions,
   stale state risks, and names that hide domain meaning.

## Verification checkpoint

Before calling `create_visual_artifact`, produce a compact fact sheet. Every claim that will appear
in the artifact must include evidence:

- `file:line` for functions, types, behavior, branches, invariants, and tests
- command output for counts or git-derived claims
- `uncertain` label for anything inferred but not verified

Do not present unsupported guesses as facts. If evidence conflicts, call out the conflict.

## Artifact structure

Build a `spec` object and call `create_visual_artifact` with:

- `slug`: `code-flow-map-<topic-slug>`
- `title`: `Code Flow Map: <topic>`
- `artifactType`: `explainer`
- `description`: one sentence naming the investigated flow and repo
- `topics`: comma-separated tags such as `code-flow,<topic>,learning`
- `nodes`: `JSON.stringify(spec.nodes)`
- `data`: `JSON.stringify(spec.data)` only when useful

Keep the artifact under Visual Artifact limits: max 30 top-level nodes, max 100 total nodes. Fold
detailed reference material into `accordion` nodes.

### Section-to-node mapping

| # | Section | Node types | Purpose |
|---|---------|------------|---------|
| 1 | Executive mental model | `heading`, `text`, `badge` | A short summary of what the flow does and why it exists. |
| 2 | Flow dashboard | `kpi-grid` | 4-6 metrics: entry points, key modules, data types, side effects, tests, risk flags. |
| 3a | **Participant diagram** (强制) | `mermaid` `sequenceDiagram` | 跨参与者/跨 boundary 的消息和调用链，不画内部分支。标注每个 participant。 |
| 3b | **Logic diagram** (条件) | `mermaid` `flowchart` | 仅当存在非平凡分支（≥3 条路径、状态机、重试/回退）时才产出。聚焦核心决策树。 |
| 4a | **State/lifecycle diagram** (条件) | `mermaid` `stateDiagram` | 有生命周期/状态转换时产出（enable→disable、draft→published 等）。 |
| 4b | **Entity/relationship diagram** (条件) | `mermaid` `erDiagram` | 有多个实体 + 关系时产出。无状态机也无实体关系时降级为 `table`。 |
| 5 | Walkthrough (强制) | `timeline` | Step-by-step execution with file/function references. Same priority as diagrams — do not fold into accordion. |
| 6 | Boundaries & Blast Radius | `accordion` | IO/adapters/side effects (table+badge) + callers, dependents, tests, docs, config (file-tree/table). |
| 7 | Tests, Gaps & Gotchas | `accordion` | Coverage table + callout for gaps + list/card of invariants and traps. |
| 8 | Grill-me starter | `callout` or `card` | The first question you will ask me after creating the artifact. |

### Diagram selection guide

Diagrams are the **highest-priority** elements of a code-flow map. They must appear as independent
top-level nodes — never buried inside accordions.

**Section 3a — Participant diagram (强制):**

Always produce a `sequenceDiagram` showing cross-boundary message flow between participants.

- Each distinct module, process, or external system is a `participant`.
- Only show calls/messages between participants; do not draw internal branches here.
- If the flow has **no cross-boundary interaction** (pure in-process pipeline), note this
explicitly and fall back to a single `flowchart` that combines 3a + 3b roles.

**Section 3b — Logic diagram (条件):**

Produce a `flowchart` **only when** the flow has non-trivial branching:

- ≥ 3 distinct code paths
- State machine or mode-dependent behavior
- Retry, fallback, or rollback loops

Focus on the core decision tree. Skip 3b for linear flows.

**Section 4 — Data/state diagram (至少一个):**

Choose based on what the flow's data actually does:

- Has **lifecycle / state transitions** (enable→disable, pending→active→done) → `stateDiagram-v2`
- Has **multiple entities with relationships** (Plugin→Settings, Project→Symlink) → `erDiagram`
- Has **neither** → fall back to a `table` of key structures

If the flow has both state transitions and entity relationships, produce both 4a and 4b.

### Compact spec shape

```ts
const spec = {
  slug: "code-flow-map-<topic-slug>",
  title: "Code Flow Map: <topic>",
  artifactType: "explainer",
  description: "Evidence-backed map of <topic> in <repo>.",
  nodes: [
    // --- Section 1-2: overview ---
    { "type": "heading", "props": { "text": "Code Flow Map: <topic>", "level": "h1" } },
    { "type": "text", "props": { "text": "<one-paragraph mental model>", "size": "xl" } },
    { "type": "kpi-grid", "props": { "columns": 3, "items": [] } },

    // --- Section 3a: participant diagram (强制, 独立顶层节点) ---
    { "type": "mermaid", "props": { "definition": "sequenceDiagram\n  participant A as \"Module A\"\n  participant B as \"Module B\"\n  A->>B: call()\n  B-->>A: result" } },

    // --- Section 3b: logic diagram (条件, 独立顶层节点) ---
    { "type": "mermaid", "props": { "definition": "flowchart TD\n  A[\"Entry\"] --> |\"condition\"| B[\"Path 1\"]\n  A --> |\"else\"| C[\"Path 2\"]" } },

    // --- Section 4a/b: data/state diagram (至少一个, 独立顶层节点) ---
    { "type": "mermaid", "props": { "definition": "stateDiagram-v2\n  [*] --> Active\n  Active --> Disabled\n  Disabled --> [*]" } },

    // --- Section 5: walkthrough (强制, 独立顶层节点) ---
    { "type": "timeline", "props": { "items": [
      { "step": 1, "title": "<step name>", "description": "<what happens and where>" }
    ] } },

    // --- Section 6-7: details in accordion (合并为 2 项) ---
    { "type": "accordion", "props": { "items": [
      { "title": "Boundaries & Blast Radius", "nodes": [] },
      { "title": "Tests, Gaps & Gotchas", "nodes": [] }
    ] } },

    // --- Section 8: grill-me ---
    { "type": "callout", "props": {
      "title": "Grill-me starter",
      "text": "<first comprehension question>",
      "variant": "info"
    } }
  ]
};

create_visual_artifact({
  slug: spec.slug,
  title: spec.title,
  artifactType: spec.artifactType,
  description: spec.description,
  topics: "code-flow,<topic>,learning",
  nodes: JSON.stringify(spec.nodes),
  data: spec.data ? JSON.stringify(spec.data) : undefined,
});
```

## Visual Artifact and Mermaid rules

- Use Visual Artifact nodes, not standalone HTML.
- Do not use `plannotator_auto_submit_review`.
- Do not open a browser directly; the Visual Artifact tool handles the window.
- **Diagrams are the highest-priority elements.** Always produce at minimum one `sequenceDiagram`
  (3a) and one data/state diagram (4). The logic `flowchart` (3b) is conditional on branch
  complexity. Every diagram must be a **top-level node**, never inside an accordion.
- Use compact Mermaid diagrams; each diagram should fit on one screen.
- Always use double-quoted Mermaid labels: `N["label text"]`, not `N[label text]`.
- Never use parentheses inside unquoted labels.
- Apply Mermaid `:::` classes on separate lines, not inline.
- Keep top-level prose short; move evidence and details into accordions.

## Grill me after the artifact

After the artifact is created, ask me exactly one comprehension question and wait for my answer.
Use this format, in my language:

```text
问题：...

我的建议：...

为什么：...
```

Start with the highest-leverage question: the one misconception that would most likely cause a bad
change to this flow. Do not ask multiple questions at once.

Ultrathink.

$@
