# ADR-0001: 护栏判定走显式排序的流水线，配置按来源分信任等级

**Status:** proposed
**Date:** 2025-11-14
**Scope:** `extensions/{bash-block-guard,safe-delete,env-guard,plan-mode,tools_intercepted,shared}`
**参考:** [czottmann/pi-automode](https://github.com/czottmann/pi-automode) — ADR-001（permission precedence / trust boundaries）、`docs/automode-classifier-flow.md`

## Context

本仓库目前有 5 个扩展在 `pi.on("tool_call")` 上做拦截：`bash-block-guard`、`safe-delete`、`env-guard`、`plan-mode`、`tools_intercepted`。它们各自注册、互不知情，因此：
1. **判定顺序不确定。** 谁先注册谁先跑，第一个返回 `{block:true}` 的扩展直接结束，后面的护栏永远看不到这次调用。`safe-delete` 拦下的 `rm`，`bash-block-guard` 不会看到，反之亦然。
2. **没有 deny/allow 语义。** 五个扩展里既有"硬拒绝"也有"提示性放行"，但对 pi 而言都是同一个 block，聚合优先级不存在。
3. **配置可被项目文件削弱。** `extensions/shared/settings.ts` 的合并是 `{ ...global, ...project }`——project 无条件覆盖 global。而 `extensions/auto-trust-work/index.ts` 把 `~/work/**` 下所有项目自动标为 trusted。两者相乘的结果是：clone 一个仓库到 `~/work`，只要提交 `.pi/third_extension_settings.json`，就能改软阈值或关掉护栏。
4. **shell 判定是手写扫描器 ×3。** `bash-block-guard/guard.ts:stripQuotedAndComments`、`safe-delete` 的 `stripHeredocBodies`、`env-guard/index.ts` 的字符级 state machine 各写各的，各自在 README 里记着"已知盲区：`sh -c "sleep 30"` 会放行"。
5. **匹配没有上界。** 所有护栏规则都是 `/regex/` 回溯匹配，而 bash 命令是外部不可信输入。

## Decision

### D1（T0）单一判定流水线

所有护栏实现为纯阶段函数 `(call: GuardCall) => GuardDecision`，由 `extensions/shared/guard-pipeline.ts` 按**显式声明的顺序**执行并聚合：

```
permission-deny → deterministic-hard-deny → path-deny → ask（人工确认） → allow-tier → 放行
```

- 阶段顺序写在代码里的一个数组常量，不依赖扩展加载顺序。
- 一次调用跑完全部阶段再聚合：deny 恒胜过 allow；多个 deny 命中时全部进 reason。
- `GuardDecision` 必须标明 `kind`（`deny` / `ask` / `allow`），禁止用"返回 undefined 表示放行"这种隐式语义。

### D2（T0）配置按来源分信任等级

`loadSettings` 不再产出单一的 `merged`：
- **user scope**（`~/.pi/agent/third_extension_settings.json`）可以设置弱化类键（阈值、`disabled` 开关）。
- **project scope**（`.pi/third_extension_settings.json`）只能加严，不能加宽。
- 键按"加严/加宽"显式分类，不允许默认推断。
- auto-trust 只表示"可以读取项目配置"，不表示"项目配置可以削弱护栏"。
- 溢出与非法输入的 fail 方向：deny 侧 fail-closed（视为命中），allow 侧 fail-open（视为不命中）。

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
