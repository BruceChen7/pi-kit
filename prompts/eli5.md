---
description: Explain a technical spec or proposed change in plain language — problem, solution, and every schema change. Output defaults to Simplified Chinese
argument-hint: "[spec/PR/branch/commit]"
---
Explain the referenced spec or change in plain language, for a technical reader who did not live the work:
they have read none of the code, none of the diff, and none of the session's messages. Simplify the
telling, never the claims. Pseudocode and precise claims land fine; invented labels do not.

thanks to  https://github.com/dzhng/skills/blob/main/skills/engineering/eli5/SKILL.md

## Scope detection — determine what to explain based on `$1`:

- File path ending in `.md` (spec, design doc, plan): read it and explain it
- Branch name (e.g. `main`, `develop`): explain the working tree vs that branch
- Commit hash: explain `git show <hash>` (that commit's diff and message)
- PR number (e.g. `#42`): `gh pr view 42` and `gh pr diff 42`
- Range (e.g. `abc123..def456`): diff between two commits
- No argument: explain the session's current change (working tree or branch diff)

If the spec alone cannot establish behavior, read the current code owners before writing.

## Writing rules

- **默认使用中文回复**：除非用户明确要求其他语言，或所引用的内容本身是其他语言（此时术语可保留原文），否则用简体中文撰写解释；代码标识符、命令和 schema 字段名保持原文。
- **Walk one concrete scenario end to end** — the triggering event, what happens today, what the
  change (or the unbuilt alternative) would do — instead of describing properties in the abstract.
- **Define every term of art at first use**; never lean on labels the spec, code, or session invented.
- **Use small concrete examples** without replacing precise claims with analogies.
- **Reach for pseudocode when explaining control flow, ordering, or timing** — at the level of the
  decision (conditions and their order), not the implementation (real signatures). The tell that you
  needed it: your prose contains "only when", "before", "unless", or "as soon as" and the reader still
  cannot say what happens on the second call.
- **Separate what exists today from what is only proposed.**
- The test: the text stands alone, without the diff, the spec, or the transcript. If the reader must
  ask "explain this part", it failed.

## Structure

Use these headings in order:

### Problem
Explain the problem through its user or operational consequence, including why the current design
produces it.

### Solution
Explain the solution as one simple before/after data flow. Introduce each component by
responsibility, not by filename or internal symbol. Lead with behavior and boundaries; mention
implementation names only when they clarify ownership or a contract.

### Schema changes
Inventory schema and durable-contract changes exhaustively: added, changed, removed, reset, and
deliberately unchanged. Include cursor or wire-format cutovers when they affect stored data or
readers. Distinguish canonical records from derived indexes, caches, summaries, and presentation
grouping. Call out destructive resets, migration requirements, compatibility behavior, eventual
consistency, and intentional data loss directly. Do not omit a change because it is operational
rather than user-visible. Say explicitly when there are no schema changes.

End with one short sentence stating what users should notice after the change.

Ultrathink.

$@
