---
name: feature
description: 新功能或行为变更的步骤清单。先定数据形状，写 throughput checkpoint，委派实现，在真实立面验证。Use when 入口 §1 判为新功能。
---

# Feature

**你拥有设计。计划、评审、验证。实现可以委派，判断不委派。**

1. 先读清受影响子系统的现状（`/skill:research`）。
2. 跨函数边界的设计用 `/skill:codebase-design` 做并行方案探索。
3. 把 throughput checkpoint 写成四个 todo 项。确实不适用的维度保留该项并写 `n/a: <理由>`，不要删。
   - **阻塞型首步。** 门禁在扇出之前跑完。
   - **独立工作流。** 不重叠的文件、服务、层可以并行。写同一处就串行。
   - **共享可变状态。** 默认先拆目标（`principles: separate-before-serializing-shared-state`）。只有真实不变量才串行。
   - **最小安全分解。** 一个 worker 最好时，写明为什么。
4. 先定数据形状再委派。形状按 `principles: model-the-domain` 选：状态机优于散落布尔，表或注册优于分支，类型化模型优于重复形状假设。委派给 `subagent general`，给文件路径、形状、验收条件。实现存在多个合理形态时（错误处理、抽象层、测试结构），改走 `/skill:arena` 让候选竞争。这一条不可省，`principles: laziness-protocol` 不覆盖它，这里图的是评审分离，不是省行数。子代理不能再生子代理时，由它自己写完并同样保留评审分离。不留「待命」式空转。
5. 在匹配的真实立面上验证。结论为「不确定」或验错了立面，都不算通过，要标出来。
6. 拆成小的有序提交。后续改动叠栈。按 `principles: sequence-verifiable-units` 每单元验证完再进下一个。
7. 设计有争议时，出货前走 `/skill:interrogate`。
8. 收尾走 `/skill:branch-commit-push`。

单功能、单迁移这类耦合紧的活交给一个 owner，checkpoint 内联。owner 在阻塞阶段之后自己扇出。父级扇出只给产出独立产物的切片。阶段边界处重写 checkpoint。换 owner 用全新的，不要链式打断。

**回复：** 做了什么，选了什么和为什么，throughput checkpoint，未决项。设计备选方案用表格。
