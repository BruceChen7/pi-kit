---
name: to-go-style-design
description: Use when the user wants to write a design document (design doc / design proposal) following Go-style design proposal conventions, or when a PRD, spec, or design discussion needs to be turned into a reviewed design document.
---

# To Design

Turn PRD / spec / design discussion into a **Go-style design document** — the kind the Go proposal repo (`golang/proposal/design`) is known for: plain language, real code examples, honest trade-offs, and a clear skeleton.

Default to Chinese unless the user explicitly asks for another language.

## Pi-native output

Primary output is a reviewed design doc spec:

`.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md`

The slug should make the artifact recognisable as a design document, e.g. `2026-06-29-rdma-conn-transport-design.md`.

This path triggers `plannotator-auto` spec review because it ends with `-design.md`.

Only place design docs under source `docs/` when the user explicitly asks.

## Context sources

Read when relevant:

- Existing PRD or spec files under `.pi/plans/<repo>/specs/`
- `.pi/contexts/**/CONTEXT.md` for domain vocabulary
- `.pi/contexts/**/adr/` for past hard-to-reverse decisions
- Related code paths if the design doc needs concrete examples
- The current conversation context (assume that's the main input)

If no PRD exists yet, you may need to run `to-prd` first. Ask the user.

## Process

### 1. Gather context

Collect the problem, scope, constraints, and any existing requirements. If the user has a PRD, read it fully. If they are describing in conversation, synthesise what is known.

### 2. Quiz the user on what cannot be inferred

Ask only about things you genuinely cannot decide from context:

- Which module / area does this design affect?
- Any known constraints not already stated?
- Want the doc to go broader (system context) or deeper (implementation detail)?

One question at a time.

### 3. Update durable language and decisions inline

If the design doc crystallises domain terms, relationships, avoided aliases, or ambiguities, update the relevant `.pi/contexts/**/CONTEXT.md` before writing the final doc.

If the design contains a hard-to-reverse, surprising trade-off with real alternatives, propose or create an ADR in `.pi/contexts/**/adr/`.

### 4. Write the design doc

Follow the Go-style template below. Every section is mandatory unless you explicitly flag it as N/A in context.

### 5. Submit for review

Write to `.pi/plans/<repo>/specs/YYYY-MM-DD-<topic>-design.md` and submit with `plannotator_auto_submit_review`.

## Go-style design doc template

```md
# Proposal: <一句话说清做什么>

**Author(s):** <作者>
**Last updated:** <日期>
**Discussion at:** <issue / 讨论链接>

## Abstract

一段话讲完全文：做什么、大致怎么做、最重要的承诺（如 "fully backward compatible with Go 1"）。

> Go 范本：摘要里就要埋下最重要的承诺，它往往是整个设计的隐含约束。

## Background / Motivation

**用具体的、可感的例子说明"痛在哪"**，而不是抽象地说"现状不好"。

写一段会出 bug 的代码、一个真实场景、一个用户遇到的困难——让读者先"疼"起来，方案才有说服力。

> Go 范本：循环变量文档直接甩出 append(&i) 的 bug 代码；错误处理文档点名包装模式已经普遍到值得收进标准库。

## Design / Proposal

文档主体。遵循"声明 + 示例 + 边界"三件套：

- **从简单到复杂，渐进式教学**。从最简例子起步，复杂概念留到读者有了直觉之后再讲。
- **每个 API 都配声明 + 代码示例**。函数签名在前，带注释的用法片段在后。
- **改造前 vs 改造后对照**。并排展示新旧写法，收益一目了然。
- **明确边界和约束**。什么场景不能用、什么情况下不生效——划清范围本身就是设计的一部分。

> Go 范本：泛型文档从 Print 最简单的例子起步；slog 文档对 Logger/Record/Handler 三个核心类型先给声明再给用法；try 明确说明只能在返回值为 error 的函数里用。

## Rationale（理由 / 取舍）

**主动暴露被放弃的方案及原因。** 这是区分"好文档"和"平庸文档"的关键章节。

- 列出备选方案
- 逐一解释为什么没选
- 坦白演进中改变过哪些选择

> Go 范本：try 的 "Design iterations" 完整记录了取舍路径；泛型专门有 "Discarded ideas" 小节坦白从 contracts 换到接口类型的原因。

## Compatibility

凡涉及破坏性变更，必须正面回应兼容性。

- 是否破坏性变更（诚实回答 yes/no）
- 代价是什么（性能、行为变化、输出差异）
- 渐进迁移路径（opt-in 机制、模块级别开关、工具辅助）

> Go 范本：循环变量文档直接说 "this is a breaking change to Go"，然后用 go.mod 版本行 opt-in、//go:build 逐文件迁移、bisect 二分工具三个机制把破坏性降到最低。

## Implementation / Transition

如何落地、分几步、配套什么工具。

- 实现步骤或阶段划分
- 配套工具（编译标志、迁移脚本、测试辅助）
- 实测数据（Google 内部数据 / 灰度结果 让"风险可控"从口号变成事实）

> Go 范本：循环变量文档附带 Google 内部全量启用实测数据（1/8000 失败率）；错误处理文档先发布 xerrors 兼容包再进标准库。

## Appendix（可选）

把会打断主线阅读的细节后置：

- 完整 API 文档
- 端到端示例
- FAQ（回应高频质疑）
```

## Writing principles

### 7 core rules

1. **标题就是结论** — 一句话说清做什么
2. **痛点用代码说，不用形容词说** — 真实 bug、真实场景最有说服力
3. **渐进式教学** — 从最简单的例子起步
4. **声明 + 示例 + 边界三件套讲 API** — 能跑的代码胜过一段描述
5. **主动暴露被否决的方案** — "没选 X，因为 Y" 比单方面论证更可信，也避免后人重复讨论
6. **诚实面对代价** — 性能变慢、输出变化、破坏兼容——都明说，再给迁移路径
7. **用数据和工具证明可落地** — 实测数据比任何"我们认为风险可控"都管用

### Voice and style

**主语切换：**
- 决策用 **"We"** 担责（"We propose...", "We decided to..."）
- 行为用 **代码本身** 当主角（"this code has a bug"）
- 说理用 **"you"** 拉近距离（"Once you have a test that fails..."）

**长短句交替：**
- 短句下结论（"That is, this code has a bug."）
- 长句讲机制（"it only applies the new semantics to new programs, so that existing programs are guaranteed to continue to execute exactly as before."）

**段落结构：**
- 一段只讲一件事
- 结论先行：段首给观点，后面是例子和数据
- 小标题本身就是完整的论点句（写 "Old code is unaffected" 而不是 "Compatibility"）

**语气：**
- 克制的诚实，甚至自嘲
- 不端着，坦白作者本人也踩过坑
- 强调要极其克制——全文只用一处斜体 `_this is a breaking change_` 反而格外醒目

## Key insight

> 写设计文档的终极目的不是"说服别人同意你"，而是"让所有人在同一个事实和取舍基础上做决定"。

> 即使被否决，文档也要写好。文档的价值不取决于提案是否通过，而取决于它是否让讨论变得高质量。

## Attribution

Inspired by and adapted from the Go proposal repository (`golang/proposal/design`), specifically the design docs for generics (43651-type-parameters), error values (29934-error-values), loopvar (60078-loopvar), structured logging (56345-structured-logging), and try (32437-try-builtin).

Derived from the article "如何写好设计文档？" by smallnest (colobu.com, 2026-06-23).
