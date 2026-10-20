---
name: principles
description: 24 条工程判断原则的索引，来自 pstack。Use when 用户点名某条原则（如 subtract-before-you-add），或 plan、design、review 的 Decisions 段需要一条有名字的判据来支撑选择时。
---

# Principles

先按当前决定挑一条，再读 `references/<id>.md` 全文。索引只给「何时适用」，判据在叶子文件里。

引用纪律：在回复、计划或设计的 Decisions 段写清两件事，用了哪条 id，它改变了哪个选择。只引用这次真的读过叶子的原则。

## 怎么用

- `/skill:principles` 只载入索引。需要哪条，再 `read references/<id>.md`。
- `/skill:principles subtract-before-you-add` 直接落到那一条。
- 其它 skill 或计划引用时写 `principles: <id>`，不要只写标题。

与现有 skill 的边界：`codebase-design`、`zero-tech-debt`、`me-tdd`、`diagnosing-bugs` 给流程，principles 给判据。流程与判据冲突时，以更具体的那条为准，并在回复里说明。

## Core

- **Laziness Protocol**（`laziness-protocol`）— 偏向删除与最小改动，不做投机抽象、层与信号穿透。适用：重构、评估 diff 大小、想加抽象时。
- **Foundational Thinking**（`foundational-thinking`）— 先定核心类型与数据结构、脚手架与功能的顺序、并发角色共享什么。适用：写逻辑之前。
- **Redesign from First Principles**（`redesign-from-first-principles`）— 新需求当成「从一开始就在」来重设计，而不是打补丁。适用：新需求要塞进旧设计时。
- **Attack the Premise**（`attack-the-premise`）— 两个以上修法共享同一前提却都失败，说明前提错了；把前提写下来直接测。适用：修复反复失败时。
- **Subtract Before You Add**（`subtract-before-you-add`）— 增改前先删死代码、冗余校验、占位引用，在更简单的基础上动工。适用：安排增改顺序时。
- **Minimize Reader Load**（`minimize-reader-load`）— 数层数与隐藏状态，合并单调用者包装，缩小可变作用域。适用：review 或重塑难追踪的代码时。
- **Outcome-Oriented Execution**（`outcome-oriented-execution`）— 按目标架构收敛，不保留一次性的兼容态。适用：有计划的重写与迁移。
- **Experience First**（`experience-first`）— 产品、UX、范围取舍时选用户体感，不选实现方便。适用：产品决策。
- **Exhaust the Design Space**（`exhaust-the-design-space`）— 没有先例的新交互或架构决策，先做 2 到 3 个竞争原型再选。适用：novel design。
- **Build the Lever**（`build-the-lever`）— 造工具（codemod、脚本、生成器、检查），让结论可复跑。适用：任何非平凡工作。

## Architecture

- **Model the Domain**（`model-the-domain`）— 用状态机、类型、表、归约器、边界表达领域，不用散落的条件分支。适用：状态逻辑多、分支多、形状假设重复时。
- **Boundary Discipline**（`boundary-discipline`）— 校验与适配放在系统边界，内部信任类型，业务逻辑保持纯。适用：接外部数据、错误处理、框架适配时。
- **Type System Discipline**（`type-system-discipline`）— 让非法状态不可表达，原始类型打 brand，边界解析外部数据。适用：设计类型与签名时。
- **Make Operations Idempotent**（`make-operations-idempotent`）— 崩溃与重试中的命令、生命周期步骤要收敛到同一终态。适用：设计命令与循环时。
- **Migrate Callers Then Delete Legacy APIs**（`migrate-callers-then-delete-legacy-apis`）— 新内部 API 一次迁完调用方并删旧，不留两套。适用：引入新 API 时。
- **Separate Before Serializing Shared State**（`separate-before-serializing-shared-state`）— 并发写同一文件、分支或 key 时，先消除共享，再谈串行化。适用：并发设计。

## Verification

- **Prove It Works**（`prove-it-works`）— 对真实产物验证，不看代理指标、自述或「能编译」。适用：收尾前。
- **Fix Root Causes**（`fix-root-causes`）— 每个症状追到第一次出错的地方再修；guard 只在被处理状态合法时才算修。适用：调试。
- **Sequence Verifiable Units**（`sequence-verifiable-units`）— 把活拆成每步都有检查的小单元，逐个验证再进下一个。适用：多步工作与提交顺序。
- **Test Behavior, Not Implementation**（`test-behavior-not-implementation`）— 断言用户可观察的行为：重构不红，行为坏了才红。适用：写、改、留测试时。
- **Explain the Number**（`explain-the-number`）— 报数字前先找限速因素，排除「测到的不是这份工作」。适用：性能、eval、任何测量。

## Delegation

- **Guard the Context Window**（`guard-the-context-window`）— 上下文快满时把批量活移出主线程，只留摘要。适用：大输出、长文件、重复读、fan-out 规划。
- **Never Block on the Human**（`never-block-on-the-human`）— 可逆工作直接做，交出结果与可回退点。适用：想先问「要不要做 X」时。

## Meta

- **Encode Lessons in Structure**（`encode-lessons-in-structure`）— 同一条指令写第二遍时，改成 lint、元数据、运行时检查或脚本。适用：发现自己在重复提醒时。
