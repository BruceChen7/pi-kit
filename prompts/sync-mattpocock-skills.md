---
description: Compare local pi-kit skills against mattpocock/skills and determine what to sync, with P0-P3 priority classification
---

# Sync mattpocock/skills

Compare the local `skills/` directory against [mattpocock/skills](https://github.com/mattpocock/skills), classify differences by severity, and sync the high-priority ones.

Default to Chinese unless the user explicitly asks for another language.

## Workflow

### 1. Recon upstream

- List upstream repo structure — categories (engineering/, productivity/, in-progress/, etc.) and individual skills under each
- Read upstream CHANGELOG.md for version history and breaking changes
- Read recent commits (last 5–10) for the latest refinements
- List any docs/ directory files that define the skill taxonomy (e.g. docs/invocation.md)
- List any .out-of-scope/ rules

### 2. Recon local

- List local `skills/` directory
- Read `skills/skills.txt` for the registered skill list and their source types (local vs git)

### 3. Build comparison matrix

Categorise every skill into one of:
- **Overlapping** — exists in both upstream and local (same or similar name)
- **Upstream-only** — new skill in upstream, not in local
- **Local-only** — local skill with no upstream equivalent

For overlapping skills, read **both** SKILL.md files to compare content depth, language adaptation, and structural differences.

### 4. Classify by severity

| Severity | Label                | Criteria                                                               | Typical patterns                                                                       |
| -------- | -------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **P0**   | Must sync            | Structural/architecture change that significantly improves the skill   | New file system (e.g. `./assets/`), extracted shared skill, changed output path/format |
| **P1**   | Strongly recommended | New features or important refinements that adapt cleanly to Pi context | New frontmatter field, new section/template, introduced external skill reference       |
| **P2**   | Moderate             | Minor polish or optional pattern improvements                          | Wording tightening, structural reorganisation (content equivalent), checklist add/drop |
| **P3**   | Minor / note         | Cosmetic or alignment-only                                             | Typo fix, description tweak, name alignment                                            |

For upstream-only skills, classify whether they're worth importing and why.

For local-only skills, note that they are Pi-native adaptations and out of scope.

### 5. Report

Produce a structured report with:
- **Summary** — version diff, notable upstream events
- **P0 list** — what to sync now, with rationale
- **P1 list** — what to sync after P0, with rationale
- **P2/P3 lists** — what to keep on radar
- **subagent delta** — 本轮上游所有提到 `Agent tool` / `Task tool` / sub-agent / fresh context 的改动单列一节，每条写清落到哪个本地文件；不适用的写明为什么（例如复盘里的 research 分支与 PR 不存在于本仓）
- **Different direction** — skills where local design deliberately diverges from upstream

For each item in P0 and P1, include the concrete changes needed.

### 6. Sync (when approved)

For each approved sync, use this 3-way merge checklist:
- [ ] **Read full local SKILL.md** —逐行标记内容来源：`[PI]` = Pi-native（中文默认、`.pi/`路径、plannotator 引用、Pi plan workflow）、`[REF]` = 本地文件引用（LANGUAGE.md、DEEPENING.md）、`[UPSTREAM]` = 来自上游
- [ ] **Read full upstream SKILL.md** — 标记 upstream 新增的结构单元（如 Assets 章节、shared skill 引用、新模板）
- [ ] **Keep** — 所有 `[PI]` 标记内容不动
- [ ] **Merge** — upstream 结构改进中与 `[PI]` 不冲突的部分，按需调整路径/名称
- [ ] **Drop** — upstream issue-tracker-specific 内容（`/setup-matt-pocock-skills`、`docs/agents/issue-tracker.md` 引用、Linear/GitHub 特定模板）
- [ ] **Map** — upstream 的委派段（`Agent tool` / `Task tool` / `sub-agent` / `sub-agent calls` / “fresh context window”）改写成本仓 `subagent` 工具：写任务与设计候选用 `general`，只读调查与解析大产物用 `explore`，评审轴用 `reviewer`；`background: true`（默认）后 `subagent action: "wait"` 收，不要轮询。`task` 必须自包含（子会话看不到本对话）。范式见 `prompts/poteto.md` §8 与 `skills/retro/SKILL.md` 第 5 步
- [ ] **Verify** — `git diff --no-ext-diff -- skills/<name>/` 只显示预期变更，没有误删 Pi 适配
- Reference this prompt in commit message: `chore: sync <skill> from <upstream-repo> (via sync-upstream-skills)`

## Constraints

- Do NOT change `disable-model-invocation` — Pi skills need descriptions for model invocation
- Do NOT remove Pi-native adaptations (Chinese default language, `.pi/` path conventions, `plannotator_auto_submit_review` delivery)
- Do NOT import upstream issue-tracker-specific references (`setup-matt-pocock-skills`, Linear/GitHub-specific templates)
- Do NOT change frontmatter `name` unless the upstream rename justifies it and it's approved
- Do NOT keep a fallback branch that assumes no subagent facility: 本仓有 `extensions/subagent/index.ts`，「没有 subagent 设施就自己跑这一步」这种句子是过期事实，一律删掉，不要与新的委派句并列保留
- Do NOT write recursion / nesting guards（对齐上游 `.out-of-scope/subagent-recursion.md`）：深度由扩展的工具白名单保证，子会话拿不到 `subagent`，skill 正文不重复这道闸
- Keep `## Attribution` up to date with upstream version info
