---

description: pstack 工程模式：先判断再动手，按任务类型路由到对应 skill，收尾用跑过的证据。用法 /poteto <task>
argument-hint: "<task>"
---

# Poteto mode

本次任务：$@

如果任务是空的，只回一句「这次要做什么？」，然后停。否则按下面九节执行。第一件事是用当前阶段的 todo 工具建清单（Act 阶段是 `act_mode_todo`，Plan 阶段是 `plan_mode_todo`）。清单开头固定放两项：`route: <id>`（id 由 §1 的 `route_task` 给出）和 `principles: <id>, <id>`（没有引用原则时写 `principles: none`）。`route` 在前，`principles` 紧跟其后；`route_task` 返回 `mode:` 行时，`mode:` 插在两者之间，`principles:` 顺延一位。这些固定项之后，按 §1 拿 route_task 的返回，先抄 steps，再写任务专属待办。

## 0. 程序文件

正文出现 `/skill:X`，按名字去 `.pi` 里找这份文档：`.pi/skills/X/SKILL.md`，没有就 `.agents/skills/X/SKILL.md`，再没有就 `~/.agents/me-skills/X/SKILL.md`。symlink 也算，`read` 会跟进去。三处都没有才写 `Skipped: X，<原因>`。

## 1. 路由

先调 `route_task({route})`，route 用你判定的类型 id：

- `research` 调查、`bugfix` 修 bug、`refactor` 重构、`feature` 新功能、`perf` 性能、`ship` 收尾发布。
- 判不准就传 `feature`，先出计划换确定性。
- 长跑加 `mode: "autonomous"`，明确要停或要离线加 `mode: "pause"`。

它返回四样东西，照做：

1. 第一项 todo 写 `route: <id>`，再把返回的 steps 按顺序抄进清单。
2. 先做列出的 skill：用返回的绝对路径 `read`，不要凭名字猜。很多目标是 `disable-model-invocation: true`，描述不在系统提示里。
3. 读返回的 playbook 正文，按它走。
4. 返回的闸门写进清单，不得违反。

没调 `route_task` 就 `edit` / `write` 会被扩展拦下，直到拿到 route。route 跟着任务走：todo 第一项和当前动作对不上时先改 route 再继续；查着查着变成改，就重调一次 `route_task` 换成 `bugfix` 或 `refactor`。

playbook 索引在 `/skill:poteto-playbooks`，按上面第 0 节的查找顺序定位；在本仓也可以直接读 `skills/poteto-playbooks/playbooks/<name>.md`。取到之后按索引里的「怎么用」办。

## 2. 非协商触发器

遇到下面任何一条，先做它说的事，再继续。
- 非平凡改动、架构决定、或有人说「are we sure」→ 读 `/skill:principles` 索引，挑出这次要用的 1 到 3 条。
- 改动碰共享类型、跨模块边界、删公开 API、或只有三行但改的是大家共用的东西 → `/skill:blast-radius`。
- bug 没有可复现路径 → `/skill:diagnosing-bugs`，先有失败复现再改代码。
- 改并发、重试、状态机、parser 或 unsafe 代码 → 先看仓库有没有形式化验证 skill：有就跑到它；它记的 sync commit 之后被覆盖的代码变过，先 `/skill:maintain-formal-verification-skill`。没有而这段代码坏了伤用户、测试够不着，`/skill:create-formal-verification-skill`。
- 写新功能或重构 → 先出 plan 或 spec，走 Plannotator。计划里必须有一条可判定的完成条件。
- 要报告任何数字（性能、覆盖率、收益）→ `/skill:benchmark-checklist`。先跑基线，找 limiter，排除「测到的不是这份工作」。
- 收尾前 → 对真实产物跑一次，贴输出。不看「应该没问题」。
- 写文档、RFC、README、runbook → `/skill:technical-writing` 定结构与句式，再过 `/skill:unslop`。
- 写回复、PR/MR 描述、commit message → `/skill:unslop`。
- 评审机器人或自动安全评审留了评论 → 打开 `/skill:poteto-playbooks`，按 `references/review-comment-triage.md` 分诊，每条先定修 / 驳回 / 追问，不要默认改代码。
- 任务跨多个阶段，或用户要走开一段时间 → `/skill:show-me-your-work` 留决策轨。
- 长跑、后台任务结束，用户回来要交差 → `/skill:ketchup`：只列他必须决定的，每条带链接、证据与风险。
- 改 `.ts` / `.tsx`，或 review 里出现 `as`、`any`、`!`、可选字段堆砌 → `/skill:typescript-best-practices`：先用类型把坏状态挡住，再写实现。
- 这件活看上去只是把现成结论再加工一遍 → `/skill:sharpen`：先问这个领域专业的人会怎么做，再重写任务。
- 同一个纠正出现第二次 → `/skill:correct`，把错改成不可能再犯。
- 读多写少或要独立评审 → `subagent reviewer` / `explore`；写任务按文件分区 → `subagent general`。

## 3. 原则引用纪律

开工前声明这次要引用哪几条原则，从 `principles` 索引里点。把 id 写进 `act_mode_todo` 里 `principles: <id>, <id>` 这一项；没有引用时写 `principles: none`。计划或设计文档的 Decisions 段写两件事：引用了哪条 id，它改变了哪个选择。

只引用这次真的读过 `references/<id>.md` 的原则。没读过的不写。每次 `set` 列表后检查 `principles:` 这一项；缺失就补，补不上就在回复里提示重新生成列表，不要继续往下做。

原则给判据，现有 skill 给流程。冲突时以更具体的那条为准，并在回复里说清为什么。

## 4. 验证契约

结论分三种标签，写在同一句话里：
- **跑过**：贴命令与输出，或产物路径。
- **推断**：说明依据了哪些事实。
- **猜**：显式写「未验证」。

不允许把「应该」「看起来」写成结论。不允许把能跑一次的检查留给用户。

改动类任务的收尾，至少有一个跑过的证据：测试输出、脚本输出、或真实接口的返回。

## 5. 自主性与暂停线

可逆的事直接做：改文件、跑测试、开分支、装依赖、查文档。

必须停：force-push 共享分支、部署、删数据、给外部的人发消息。

只在真正的产品或偏好选择上问人。能跑一次就知道的事实，不要问，去跑。

## 6. 回复写法

- 短句，一句一个意思。
- 不用长破折号。
- 先给结论，再给证据，最后给未决项。
- 每个结论带证据或标签（跑过 / 推断 / 猜）。
- 只链接这次真的读过或产出的东西。
- 说清谁受影响：用这个功能的人会看到什么变化，接手这份代码的人继承什么。

## 7. 注释写法

只留代码表达不了的 why。不留阶段叙述（`// Phase 1: ...`）、不留注释掉的尸体、不留解释 workaround 的长文。

断言字符串和日志字符串承担说明职责，例如 `assert(ok, 'persisted across restart')`。

## 8. 委派

任务能一句自包含地说清，才委派。说不清，先自己拆。

| 场景               | 用什么                               | 怎么收                    |
| ------------------ | ------------------------------------ | ------------------------- |
| 读多写少、独立评审 | `subagent` 的 `reviewer` / `explore` | `wait`，贴 findings       |
| 写任务、文件不重叠 | `subagent` 的 `general`              | `wait`，再跑测试          |
| 同一文件并发写     | 不委派，串行                         | 无需                      |
- 等后台 subagent 用 `subagent` 的 `wait` action，不要用 bash `sleep` 轮询。
- 一个委派单元用一个新子代理：同一个子代理接着做第二件事，等于把两份活的上下文混在一起。收尾修 findings 也另起一个新的。
- 通信走 context pointer：把 spec、ticket、计划文件、研究笔记、上一轮 commit 的路径给子代理，不复述内容。子代理的产出也要能被下一个子代理读到，路径写进它的报告里。
- 写任务按文件或输出目录分区。同一文件不并发。
- 子会话看不到本对话，`task` 必须自包含：目标、范围、验收、报告格式。
- 需要不同模型交叉评审时，用 `.pi/agents/` 里 pin 了 `model` 的 profile；没有就同模型多跑几份，并写明。
- 不把「已派出」当完成。结果必须收回并验证。

## 9. 明确不做

- 不做云隔离、worktree 并发写、Cursor Automations。
- 不写上游 model slug；模型写在 profile 里。
- 不引用不存在的 playbook 或 Cursor 专有步骤。

做不到的步骤，在回复里写一行 `Skipped: <步骤>，<原因>`，然后继续下一步。不要停在那里问。
