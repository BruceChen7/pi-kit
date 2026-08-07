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
   TUI/RPC/UI interactions, databases, caches, env vars, clocks, and global state. 为每个副作用
   记录 `file:line`：边界树里副作用节点必须带行号。
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
detailed reference material into `accordion` nodes. Captions count toward the top-level budget
(each diagram +2: `heading` + `text`); if 3a/3b/4a/4b are all produced and the budget is tight,
trim the 3b caption first — never cut 3a or Section 6.

### Section-to-node mapping

| # | Section | Node types | Purpose |
|---|---------|------------|---------|
| 1 | Executive mental model | `heading`, `text`, `badge` | A short summary of what the flow does and why it exists. |
| 2 | Flow dashboard | `kpi-grid` | 4-6 metrics: entry points, key modules, data types, side effects, tests, risk flags. |
| 3a | **Participant diagram** (强制) | `heading` + `text` 图注, `mermaid` `sequenceDiagram` | 跨参与者/跨 boundary 的消息和调用链，不画内部分支。标注每个 participant。 |
| 3b | **Logic diagram** (条件) | `heading` + `text` 图注, `mermaid` `flowchart` | 仅当存在非平凡分支（≥3 条路径、状态机、重试/回退）时才产出。聚焦核心决策树。 |
| 4a | **State/lifecycle diagram** (条件) | `heading` + `text` 图注, `mermaid` `stateDiagram` | 有生命周期/状态转换时产出（enable→disable、draft→published 等）。 |
| 4b | **Entity/relationship diagram** (条件) | `heading` + `text` 图注, `mermaid` `erDiagram` | 有多个实体 + 关系时产出。无状态机也无实体关系时降级为 `table`。 |
| 5 | Walkthrough (强制) | `timeline` | Step-by-step execution with file/function references. Same priority as diagrams — do not fold into accordion. |
| 6 | **Boundary tree** (强制, 独立顶层节点) | `section` (title: "Boundary Map") 内含 `code-block` | ASCII 调用树：副作用/IO 节点带 `← 注释` + `file:line`；纯逻辑节点省略行号。见 Boundary tree guidance。 |
| 7 | Blast Radius + Tests/Gaps/Gotchas | `accordion` (2 项) | 项 1 "Blast Radius"：callers, dependents, tests, docs, config (file-tree/table)。项 2 "Tests, Gaps & Gotchas"：Coverage table + callout for gaps + list/card of invariants and traps. |
| 8 | Grill-me starter | `callout` or `card` | The first question you will ask me after creating the artifact. |

**图注规则（所有 mermaid 图强制）：** 每个 mermaid 图之前必须紧跟两行图注：`heading`（level `h2`，图名）+ 一行 `text`（≤60 字）。

`text` 必须根据这张图**实际画出的内容**撰写，从该图的 mermaid definition 反推，写"图里有什么"：

- 3a：概括真实参与者与消息，如 "CLI → PluginManager → FS 同步调用链，箭头标签为传入参数"；
- 3b：写真实分支，如 "决策树：拦截链放行 / 降级 / 失败回退"；
- 4a/4b：写真实状态转换或实体关系。

禁止：

- 套模板句（如一律写 "跨 boundary 的消息流：谁调用谁"）——图注必须能被该图本身验证；
- 声称图里没有的元素；
- 在排除句里枚举省略项——"内部分支不在此图"是通用句即可，被省略内容的具体名称由对应图（3b）的正面图注承担；
- 写 "见 3a/3b" 编号指针（页面上没有可见编号）——跨图指针只允许 "见下方 Logic Diagram"，且仅当 3b 实际产出时写。

图注与图都是独立顶层节点，顺序为 `heading` → `text` → `mermaid`，不允许只丢一个裸 mermaid。每张图 +2 个顶层节点，计入 30 上限；4a/4b 同时产出时各自保留图注（预算紧张时优先合并 3b 图注为一行）。

### Diagram selection guide

Diagrams are the **highest-priority** elements of a code-flow map. They must appear as independent
top-level nodes — never buried inside accordions. Every diagram is preceded by its caption
(`heading` + one-line `text`) per the caption rule above.

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

**Section 6 — Boundary tree (强制, 独立顶层节点):**

IO 边界/副作用用 ASCII 调用树呈现，取代平表。顶层是一个 `section` 节点（`title: "Boundary Map"`），内含一个 `code-block`，对齐 plan-mode 的 Implementation ASCII call tree 约定。根节点是入口函数或顶层模块调用，用 `├─/└─/│` 表达层级：

```text
bootstrapDefaultManagedPlugins(cwd, plugins)
├─ 读 defaultDisabledPlugins（默认: copyx, pi-autoresearch）
└─ plugins.filter(isDefaultBootstrapEntry)  ← 排除 plugin-toggle, shared
     └─ bootstrapPlugins(...)
          └─ 遍历: disabled.has(name) → skip
               其余 → enablePlugin()  ← 副作用: 写 symlink, extensions/plugin-toggle/project.ts:142
```

- **Side-effect/IO nodes must carry `file:line`**: `← side effect: <type>, <full-path>:<line>`,
  type from a fixed vocabulary (read-file/write-file/network/subprocess/clock/env/global-state).
- Pure logic nodes (filter, branching) omit the line number; one node per line, description ≤ 60 chars.
- Depth ≤ 6, total nodes ≤ 20: fold oversized subtrees as `└─ … (N items)`, or split into multiple trees.
- **IO completeness**: the tree must cover every side-effect node; only pure-logic details may be trimmed.

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
    // 图注: heading(图名) + 一行 text(图是 what / 怎么读)，然后才是 mermaid
    { "type": "heading", "props": { "text": "Participant Diagram: CLI → Plugin Manager → FS", "level": "h2" } },
    { "type": "text", "props": { "text": "CLI → PluginManager → FS 同步调用链，箭头标签为传入参数；内部分支不在此图。" } },
    { "type": "mermaid", "props": { "definition": "sequenceDiagram\n  participant CLI as \"CLI\"\n  participant PM as \"PluginManager\"\n  participant FS as \"FS\"\n  CLI->>PM: config\n  PM->>FS: write symlink\n  FS-->>PM: result" } },

    // --- Section 3b: logic diagram (条件, 独立顶层节点) ---
    { "type": "heading", "props": { "text": "Logic Diagram: 启用插件的核心决策树", "level": "h2" } },
    { "type": "text", "props": { "text": "决策树：condition 命中 → Path 1，否则 → Path 2。" } },
    { "type": "mermaid", "props": { "definition": "flowchart TD\n  A[\"Entry\"] --> |\"condition\"| B[\"Path 1\"]\n  A --> |\"else\"| C[\"Path 2\"]" } },

    // --- Section 4a/b: data/state diagram (至少一个, 独立顶层节点) ---
    { "type": "heading", "props": { "text": "State Diagram: 插件生命周期", "level": "h2" } },
    { "type": "text", "props": { "text": "状态转换：初始 → Active → Disabled → 终态；无生命周期则用 table 代替。" } },
    { "type": "mermaid", "props": { "definition": "stateDiagram-v2\n  [*] --> Active\n  Active --> Disabled\n  Disabled --> [*]" } },

    // --- Section 5: walkthrough (强制, 独立顶层节点) ---
    { "type": "timeline", "props": { "items": [
      { "step": 1, "title": "<step name>", "description": "<what happens and where>" }
    ] } },

    // --- Section 6: boundary tree (强制, 独立顶层节点) ---
    // section 包裹 ASCII 调用树: 副作用节点带 file:line，纯逻辑节点省略行号
    { "type": "section", "props": { "title": "Boundary Map", "nodes": [
      { "type": "code-block", "props": { "code": "bootstrapDefaultManagedPlugins(cwd, plugins)\n├─ 读 defaultDisabledPlugins（默认: copyx, pi-autoresearch）\n└─ plugins.filter(isDefaultBootstrapEntry)  ← 排除 plugin-toggle, shared\n     └─ bootstrapPlugins(...)\n          └─ 遍历: disabled.has(name) → skip\n               其余 → enablePlugin()  ← 副作用: 写 symlink, extensions/plugin-toggle/project.ts:142", "language": "text" } }
    ] } },

    // --- Section 7: details in accordion (2 项) ---
    { "type": "accordion", "props": { "items": [
      { "title": "Blast Radius", "nodes": [] },
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
- **Diagrams are the highest-priority elements.** Always produce at minimum one `sequenceDiagram`
  (3a) and one data/state diagram (4). The logic `flowchart` (3b) is conditional on branch
  complexity. Every diagram must be a **top-level node**, never inside an accordion, and must be
  preceded by its caption (`heading` + one-line `text`). 边界树
  (Section 6 `section`) 同样必须独立顶层节点，不进 accordion。
- **每个 mermaid 图前必须有图注**：`heading`（h2，图名）+ 一行 `text`（≤60 字，根据图的实际内容撰写：写"图里有什么"，禁止模板句、禁止枚举省略项、禁止 "见 3a/3b" 编号指针），然后是 `mermaid`。图注与图都是独立顶层节点，不允许裸 mermaid。
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
