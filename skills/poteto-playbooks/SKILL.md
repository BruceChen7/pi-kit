---
name: poteto-playbooks
disable-model-invocation: true
description: 按任务类型取一份步骤清单，抄进 todo，跳过的留 skip 行。Use when 入口 §1 给出 playbook 名，或要把重构、性能、运行时诊断、长跑、停机按固定步骤走。
---

# Poteto playbooks

## 怎么用

1. 从下表取一份，读全文。
2. 把步骤逐字抄进 `act_mode_todo`，在任何任务专属待办之前。
3. 不做的步骤留在列表里，写一行 `skip: <理由>`。
4. 步骤里点名 `/skill:X` 的，按入口第 0 节的查找顺序定位。
5. 步骤里写 `principles: <id>` 的，打开 `/skill:principles`，读 `references/<id>.md` 再引用。

## 已进口

| playbook | 什么时候用 | 交付物 |
|---|---|---|
| `playbooks/feature.md` | 新功能或行为变更 | 设计、throughput checkpoint、真实立面验证 |
| `playbooks/refactoring.md` | 结构变行为不变 | 行为契约、等价性证明、读者负担变化 |
| `playbooks/perf-issue.md` | 一次性性能修复 | 基线与修复后数字、差值、产物路径 |
| `playbooks/runtime-forensics.md` | 活进程有症状 | 带引用的诊断，不修 |
| `playbooks/trace-forensics.md` | 手上已有 profile 或快照 | 带引用的诊断，不修 |
| `playbooks/autonomous-run.md` | 跑完为止的长跑 | 退出条件、轮次、最终谓词状态 |
| `playbooks/pause-safely.md` | 明确要停或要离线 | 落盘的 wip 提交、resume note |

评审意见分诊在 `references/review-comment-triage.md`。三个判定是修、驳回、追问。

## 没有 playbook 的类型

有本地替代的走替代。调查走 `/skill:research` 或 `/skill:wayfinder`，修 bug 走 `/skill:diagnosing-bugs`，原型走 `/skill:prototype`，写 skill 走 `/skill:skill-creator`，接手在飞的活走 `/skill:handoff`，开 PR 走 `/skill:branch-commit-push`。

其余类型本仓没有步骤清单。不要现编一份，也不要说「本仓没有这个能力」。跨阶段的大活先出 plan 走 Plannotator。
