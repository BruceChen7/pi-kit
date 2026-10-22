---
name: typescript-best-practices
description: "TypeScript 的具体写法表：用类型让坏状态写不出来，别靠运行时守卫和断言。写或 review 任何 .ts / .tsx 时用。Use when 新增或修改 TypeScript 文件、设计一个形状或多状态字段、读别处 TS 代码、或 review 里出现 `as`、`any`、`!`、可选字段堆砌。"
disable-model-invocation: true
---

# TypeScript best practices

先按 `type-system-discipline` 原则办，这份表是它的具体写法。

| 规则 | 要点 |
|------|------|
| Discriminated unions | 用 `kind` 字面量区分变体，让不可能的组写不出来。不要用「一个布尔 + 一堆可选字段」的袋子。 |
| Branded types | 给原始类型加 `& { readonly __brand: "X" }`，让它们不能互相混。在边界上只校验一次。brand 只能来自会真的验证的类型守卫（`input is AgentId`），永远不来自 `as`。 |
| Constructive modeling | 把形状做成「非法值构造不出来」：非空用 `[T, ...T[]]`，偶数长度用 `[T, T][]`，区间用 `start` 加 `duration`。不要靠运行时守卫，也不要指望 refinement type。 |
| Simplest total type | 只要每个操作都还成立，就留在 `T[]`。等到松散类型逼你写 `!`、cast 或「不该发生」的 throw，才收紧成 `NonEmpty<T>`。 |
| `unknown` over `any` | 外部数据是 `unknown`。 |
| Schemas before guards | 手写逐字段类型守卫之前，先用仓库现有的运行时 schema 库，从 schema 推出类型，例如 `z.infer`。 |
| No `as` casts | 每个 `as` 都是一次等着发生的运行时崩溃。校验之后才 cast。 |
| Narrowing hierarchy | 判别式 switch > `in` > `typeof` / `instanceof` > 自定义类型守卫 > `as`。 |
| Type guards | 守卫必须真的验证它声称的事。说谎的守卫比 `as` 更糟，因为 bug 躲在一个说它安全的名字后面。命名用 `isX` 或 `hasX`。 |
| Exhaustiveness | 在 default 分支写 `const _exhaustive: never = x;`，新增变体时编译器会报错。 |
| `satisfies` over `as` | 校验取值但不把字面量类型放宽。 |
| Boundary validation | 数据跨进来时当场 parse 成有名字的领域类型。`Record<string, unknown>`（不管怎么写）到那次 parse 为止。类型以内的部分可以信。见 `boundary-discipline` 原则。 |
| Schema-derived types | 声明新 interface 之前，先用 `Pick` / `Omit` / `Parameters` / `ReturnType` / `Awaited` / `typeof`。 |
| Object args | 传对象，不传位置参数，参数顺序自带说明。热路径除外（逐帧渲染、tokenizer、parser）。 |
| Real tests | 能真跑的就别 mock。优先用框架真实的测试原语，带泄漏与 disposable 检查；UI 在真的跑起来的构建里验。只 mock 本地跑不起来的。 |
| Structured telemetry | 用结构化日志，带一个 id 就能查清现场。发布出去的代码里没有 `console.log`。 |

例子见 [`references/patterns.md`](references/patterns.md)。
