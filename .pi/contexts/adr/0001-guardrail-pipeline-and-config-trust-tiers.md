# ADR-0001: 护栏判定走显式排序的流水线，配置按来源分信任等级

**Status:** accepted — D1、D2、D4、D5 已实现（2026-11-14），D3 只剩 env-guard
**Date:** 2026-11-14
**Scope:** `extensions/{bash-block-guard,safe-delete,plan-mode,shared}`
**参考:** [czottmann/pi-automode](https://github.com/czottmann/pi-automode) — ADR-001（permission precedence / trust boundaries）、`docs/automode-classifier-flow.md`

## Context

本仓库有 3 个护栏型扩展在 `pi.on("tool_call")` 上做拦截：`bash-block-guard`（拒）、`safe-delete`（问）、`plan-mode`（拒）。另有 `poteto-route` 的路由闸门与 `tutor/notes-store` 的教学约束也挂在这个事件上，但它们不是安全护栏。`env-guard` 走的是 bash hook（改写命令），`tools_intercepted` 只在 `session_start` 注册工具包装，两者都不在 `tool_call` 上拦截。

这些拦截器各自注册、互不知情，因此：
1. **判定顺序不确定。** 谁先注册谁先跑，第一个返回 `{block:true}` 的扩展直接结束，后面的护栏永远看不到这次调用。`safe-delete` 拦下的 `rm`，`bash-block-guard` 不会看到，反之亦然。
2. **没有 deny/ask 语义。** 三个拦截器里既有硬拒绝也有"问一下用户"，但对 pi 而言都是同一个 block，聚合优先级不存在：一条被 deny 的调用仍然可能先弹出确认框。
3. **配置可被项目文件削弱。** `extensions/shared/settings.ts` 的合并是 `{ ...global, ...project }`——project 无条件覆盖 global。而 `extensions/auto-trust-work/index.ts` 把 `~/work/**` 下所有项目自动标为 trusted。两者相乘的结果是：clone 一个仓库到 `~/work`，只要提交 `.pi/third_extension_settings.json`，就能改软阈值或关掉护栏。
4. **shell 判定是手写扫描器 ×3。** `bash-block-guard/guard.ts:stripQuotedAndComments`、`shared/shell-text.ts` 的 `stripHeredocBodies`（safe-delete 与 bash-block-guard 共用）、`env-guard/index.ts` 的字符级 state machine 各写各的，各自在 README 里记着"已知盲区：`sh -c "sleep 30"` 会放行"。
5. **匹配没有上界。** 所有护栏规则都是 `/regex/` 回溯匹配，而 bash 命令是外部不可信输入。

## Decision

### D1（T0）单一判定流水线

所有护栏实现为纯阶段函数 `(call: GuardCall) => GuardDecision`，由 `extensions/shared/guard-pipeline.ts` 按**显式声明的顺序**执行并聚合：

```
permission-deny → deterministic-hard-deny → path-deny → ask（人工确认） → allow-tier → 放行
```

- 阶段顺序写在代码里的 `GUARD_STAGE_RANK` 里，不依赖扩展加载顺序。
- deny 阶段先全部跑完；只要有一个 deny，ask 阶段就不再打扰用户。多个 deny 命中时全部进 reason，段落顺序由 `GUARD_STAGE_RANK` 决定。
- 判决必须带 `kind`（`deny` / `ask`）与 `rule`，禁止用"返回 undefined 表示放行"这种隐式语义。
- 阶段自己抛错时 fail-closed：说不出"安全"就不放行。

### D2（T0）配置按来源分信任等级

`settings.ts` 增加 `resolveTrustedSettings(global, project, rules)`：合并仍然是"项目覆盖全局"，但 `rules` 里列出的键只能加严 —— 项目值在放宽时保留全局值，全局也没有就删掉回到内置默认，并把被忽略的键报给调用方。
- **user scope**（`~/.pi/agent/third_extension_settings.json`）可以设置弱化类键（阈值、`disabled` 开关）。
- **project scope**（`.pi/third_extension_settings.json`）只能加严，不能加宽。
- 键按"加严/加宽"显式分类（`TrustRule`），由知道语义的扩展提供，不通用推断。
- auto-trust 只表示"可以读取项目配置"，不表示"项目配置可以削弱护栏"。
- 被忽略的项目键必须上报（plan-mode 在 `restore` 时 `ui.notify` 一次），不许静默吞掉。
- 溢出与非法输入：deny 侧 fail-closed（`input-too-large` 直接拒），allow 侧 fail-open（视为不命中）。

### D3（T1）共享 shell AST 层

bash 命令是不可信输入，由一个共享解析层产出结构化结果（命令名、参数、重定向目标、结构是否可判定、是否存在 unresolved 动态执行），取代三份手写扫描器。
- 动态执行（`sh -c "…"`、`eval`、变量拼出的命令名）不得静默放行，必须是显式 `unresolved` 分支：要么 fail-closed，要么进显式 allowlist。
- 现有 README 里的"已知盲区"随迁移变成测试用例。

### D4（T1）Core 纯函数 + Shell 薄包装

- 判定逻辑为 value-in / value-out 纯函数，Shell 只做读事件、取配置、把 Decision 交回 pi（`bash-block-guard/guard.ts` 已是这个形状，作为模板）。
- 副作用（时钟、fs、env、解析器、LLM）通过工厂选项注入，测试不依赖真实磁盘、时钟或网络。
- `safe-delete`（1201 行、进程内直接 `child_process` + `fs`）是这批里工作量最大的一项。

### D5（T1）匹配有界

- pattern 上限 4096 UTF-16 code units，input 上限 1 MiB。
- enforce 路径使用线性时间匹配（KMP 或等价），禁止可能回溯爆炸的 regex。

## Consequences

- 新增护栏变成"往阶段表加一行"，而不是"再挂一个 `tool_call` 监听器"；已有的互相遮蔽缺陷会在迁移时以测试用例的形式暴露。
- `loadSettings` 的调用方需要区分 `userMerged` / `effective`，并对每个键标注加严方向——这是一次性但必须逐个做完的工作。
- 三份扫描器合并后，`bash-block-guard` 的两条"已知盲区"从 README 讨论升级为显式 `unresolved` 分支。
- 明确**不引入** LLM 分类器（T3）：确定性能覆盖的场景不花钱、不失败开放。只有当确定性层无法表达（例如"这个 `rm` 是否在清理临时目录"）时才另立 ADR。
- 不改变任何扩展的独立可卸载性：流水线是共享模块，不是新的常驻扩展。

## Non-goals

- 不是 sandbox。与 pi-automode 一样，这些护栏只能降低自主执行的风险，不能作为 OS 安全边界。
- 不统一各扩展的 UI/文案风格。
- 不处理 `!` / `!!` 用户手动 shell 命令。

## 实现状态

已落地（2026-11-14）：

| 项             | 落点                                                                                                         | 证据                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| D1 流水线 Core | `extensions/shared/guard-pipeline.ts`                                                                        | `aggregateVerdicts` / `evaluateGuards` / `GUARD_STAGE_RANK`                           |
| D1 唯一处理器  | 同上 `installGuardPipeline`                                                                                  | 按 pi 实例去重；`extensions/shared/guard-pipeline.test.ts` 断言装两次只有一个 handler |
| D1 迁移        | `bash-block-guard`（deny）、`safe-delete`（ask）、`plan-mode`（deny，`extensions/plan-mode/guard-stage.ts`） | 各自 `registerGuard(...)` + `installGuardPipeline(pi)`                                |
| D2 信任等级    | `extensions/shared/settings.ts`：`resolveTrustedSettings` / `loadTrustedSettings`                            | `extensions/shared/settings.test.ts`                                                  |
| D2 接线        | `extensions/plan-mode/state.ts`：`PLAN_MODE_TRUST_RULES` + `loadPlanModeConfigWithDiagnostics`               | `extensions/plan-mode/config-trust.test.ts`                                           |
| D5 一部分      | `MAX_GUARD_TEXT_LENGTH` 1 MiB → `input-too-large` deny                                                       | 同上                                                                                  |

| D5 判定路径（`safe-delete`） | 7 个 detector 改读命令段（有效命令名 / 参数 / 重定向 / wrappers），不再对原文跑正则；`sudo` 由结构层标出 | `extensions/safe-delete/analyze.test.ts` 新增 6 条（含 `sh -c`、`eval`、引号路径） |

D3 剩下的只有 `env-guard`：它做的是命令改写（往 `git diff` 前注入 env 与 flags），不是拦截，优先级最低。

留在流水线外的拦截器：`poteto-route`（路由闸门，不是安全护栏）、`tutor/notes-store`（教学约束）。它们将来若要并入，按 `kind: "deny"` 注册即可，不需要改流水线。
