---
name: perf-issue
description: 一次性性能修复的步骤清单。先取基线，按便宜到贵的箴言排序，改一处测一次。Use when 入口 §1 判为性能。
---

# Perf issue

**你拥有测量故事。计划、评审、验证数字。** 每个修法都绑一次测量，不要读源码代替测量。

1. 取基线 trace。基线与后面每个数字都过 `/skill:benchmark-checklist`。
2. 读清子系统定假设（`/skill:research`）。没跑过就不要宣称性能上限。
   按便宜到贵的顺序试性能箴言。
   1. 不做。结果没人用的工作直接停，不是把它变便宜。
   2. 做，但别做第二次。
   3. 少做。
   4. 晚点做。
   5. 趁人不注意做。
   6. 并发做。
   7. 更便宜地做。
   更早的箴言命中目标就停。
3. 从 trace 出方案。跨函数边界先用 `/skill:codebase-design`。实现委派给 `subagent general`，模型用 profile 里配的。审 diff，取修复后 trace。按 `principles: sequence-verifiable-units` 每次尝试验证完再试下一个。
4. 解析并对比产物（JSON 进 sqlite，再 diff）。「不确定」或验错立面都不算通过，要标出来。
5. 在 PR 里引用测量。
6. 收尾走 `/skill:branch-commit-push`。

要的是对一个指标持续爬坡而不是一次性修法时，走 `/skill:benchmark-checklist` 的循环口径，每次假设都留前后测量。

**回复：** 基线与修复后数字、差值、产物路径。
