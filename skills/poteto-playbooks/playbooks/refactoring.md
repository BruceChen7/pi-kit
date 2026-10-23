---
name: refactoring
description: 行为不变的结构变更步骤清单。先钉行为契约，再小幅移动，最后用等价性证明收尾。Use when 入口 §1 判为重构。
---

# Refactoring

**你拥有契约。结构变，行为不变。** 与 Feature 加行为、Bug fix 修行为都不同。

清理中发现的缺失功能或真 bug，拆出去先发结构改动，再对着钉住的契约做。允许重设计，但要命名并改走 Feature。跨模块的大结构改动先出 plan 走 Plannotator，本 playbook 管聚焦到中等规模的改动。

1. 先钉行为契约。读清受影响子系统的现状（`/skill:research`），写一个刻画测试、快照或等价性 harness，在任何结构移动之前抓住当前行为。该区域没有覆盖时，先写钉住再动结构。类型检查与 lint 不算钉住。
2. 命名缺失的结构，按 `principles: model-the-domain`。形状已经清楚且局部时，无聊的代码留着。重塑必须删分支或删非法状态，不是加间接层。
3. 命名目标形状。写清今天从零建时模块布局、类型、调用图该是什么样（`principles: foundational-thinking`，`principles: redesign-from-first-principles`）。目标跨函数边界时，先用 `/skill:codebase-design` 做形状的并行方案探索。
4. 删在加之前。先删死代码、合并单调用者包装、去掉冗余校验、清理孤儿引用（`principles: subtract-before-you-add`）。达到目标形状的最小改动就发（`principles: laziness-protocol`）。「也许有用」的投机清理回滚。
5. 小步移动，每一步保持钉住为绿。API 重塑时一次迁完所有调用方并删旧 API（`principles: migrate-callers-then-delete-legacy-apis`）。不留兼容垫片，不留新旧并行路径。每个改名对着真实文件抽查，改名会漏字符串、散文与反向引用里的用法。机械改动委派给 `subagent general`，给文件路径、要移动的名字、要守住的行为。
6. 在真实产物上证明行为不变，不是「能编译」（`principles: prove-it-works`）。较大重塑跑等价性检查：一个 diff 新旧输出的脚本，重放录制基线，或在匹配立面上冒烟跑一次。
7. 确认这次改动值得留。成功度量是读者负担下降（`principles: minimize-reader-load`）。diff 没有在某处降低读者负担就回滚。
8. 拆成小的有序提交：一个减法提交，再是重塑，再是后续清理。按 `principles: sequence-verifiable-units` 让每个行为不变的切片先绿。收尾走 `/skill:branch-commit-push`。

**回复：** 改了什么结构，对着什么钉住，等价性证明，读者负担变化，什么发了什么回滚了。没有新行为。
