# poteto 模式（常驻）

本会话已开启 poteto 模式，每轮按下面五段执行，不必重新读入口文档。

## 路由

第一项 todo 写 `route: <类型>`，第二项写 `principles: <id>, <id>`（没有引用写 `none`）。

| 类型 | 先做 | 收尾 |
|---|---|---|
| 调查 | /skill:research 或 /skill:wayfinder；运行时有症状走 playbook: runtime-forensics，手上有快照走 playbook: trace-forensics | 带引用的结论，不改码 |
| 修 bug | /skill:diagnosing-bugs 建反馈回路 | 复现，根因，最小修复 |
| 重构 | plan 里先写「行为不变」判据，步骤走 playbook: refactoring | /skill:review |
| 新功能 | plan 或 spec，步骤走 playbook: feature | 真实立面验证 |
| 性能 | 先跑基线，步骤走 playbook: perf-issue | /skill:blast-radius |
| 长跑 | playbook: autonomous-run；要停或离线走 playbook: pause-safely | 退出条件与最终谓词状态 |
| 收尾发布 | /skill:review 双轴 | 重跑测试，conventional commit |

playbook 取法：读 `{{PLAYBOOKS}}/<name>.md`，步骤逐字抄进 todo，不做的留 `skip: <理由>`。本节点名的 `/skill:X` 在本仓不存在时，写一行 `Skipped: X，<原因>` 再继续。

## 证据

结论标签写在同一句里。跑过 = 贴命令加输出末行原文，例如 `npx vitest run x` → `Tests  12 passed (12)`。推断 = 列依据的事实。猜 = 写「未验证」。不用「应该」「看起来」当结论。

## 委派

角色名就是 `subagent` 的 `agent` 参数。只读角色没有写权限。

| 场景 | agent |
|---|---|
| 写功能、重构 | code |
| 修 bug | bug-fix |
| 性能 | perf |
| 爬指标 | hillclimb |
| 设计判断 | judgment（只读） |
| 最难的活 | strongest |
| 独立评审 | review（只读，diff 先落临时文件再把路径给它） |
| 文字产出 | prose |
| 验证 | verification（只读） |

同一文件不并发，写任务按文件分区。子会话看不到本对话，task 必须自包含。

## 暂停线

可逆直接做。必须停：force-push 共享分支、部署、删数据、给外部的人发消息。

## 与 plan-mode 的关系

计划产物与评审门由 plan-mode 管，本模式不重复，也不切阶段。todo 工具按当前阶段用：Act 是 `act_mode_todo`，Plan 是 `plan_mode_todo`。
