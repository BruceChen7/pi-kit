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
4. 先定数据形状再委派。形状按 `principles: model-the-domain` 选：状态机优于散落布尔，表或注册优于分支，类型化模型优于重复形状假设。委派给 `subagent general`，给文件路径、形状、验收条件。实现存在多个合理形态时（错误处理、抽象层、测试结构），改走 `/skill:arena` 让候选竞争。这一条不可省，`principles: laziness-protocol` 不覆盖它，这里图的是评审分离，不是省行数。子代理自己写完时同样保留评审分离。不留「待命」式空转。
   每个委派的 task 自带预算：读 ≤ 8 个文件、输出 ≤ 60 行、6 分钟没有产出先 `status` 再决定是否 `stop`；停下来的子代理会把已发现的结论交回父级，不要让它静默跑满。
   每个实现单元用一个**新的**子代理，同一个子代理不做第二件事。探索产物（现状清单、外部事实）落成一个后续子代理都能读的路径（`.pi/plans/<repo>/`），实现子代理只拿路径，不拿复述。
5. 在匹配的真实立面上验证。结论为「不确定」或验错了立面，都不算通过，要标出来。
6. 拆成小的有序提交。后续改动叠栈。按 `principles: sequence-verifiable-units` 每单元验证完再进下一个。
7. 设计有争议时，出货前走 `/skill:interrogate`。
8. 收尾按 gate「review 后台派」执行：
   - 跑 `git diff --stat <base>` + 一行 spec 对照，写进回复。
   - diff ≤ 60 行且 ≤ 3 个文件 → 自己过一遍双轴，不派子代理。
   - 否则 `subagent` 后台派双轴（`background: true`），**不 wait**，本轮继续或结束；findings 到达后再派一个全新的子代理修。
   - 用户明确要「当场给结论」才 wait，上限见 `/skill:review` 第 5 步。
9. 收尾走 `/skill:branch-commit-push`。

单功能、单迁移这类耦合紧的活交给一个 owner，checkpoint 内联。owner 在阻塞阶段之后自己扇出。父级扇出只给产出独立产物的切片。阶段边界处重写 checkpoint。换 owner 用全新的，不要链式打断。

**回复：** 做了什么，选了什么和为什么，throughput checkpoint，未决项。设计备选方案用表格。
