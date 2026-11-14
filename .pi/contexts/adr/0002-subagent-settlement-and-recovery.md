# ADR-0002: 子 agent 的结算、持久化与跨扩展事件协议

**Status:** accepted — T0 与 T1 全部落地（2026-11-14）
**Date:** 2026-11-14
**Scope:** `extensions/subagent`、`extensions/shared/internal-events.ts`
**参考:** [mavam/pi-agents](https://github.com/mavam/pi-agents) — `docs/design.md`（Obligations / Delivery / Recovery）、`docs/hooks.md`、`docs/architecture.md#state-snapshots`、`src/agents/obligations.ts`、`src/agents/receipts.ts`

## Context

`extensions/subagent` 是 pi-kit 里唯一"跨轮次、跨会话、有生命周期"的扩展：它起子会话、跑任务、把结果送回父会话。它的形状已经超出单次工具调用的范围，但内部仍是"一次调用 + 一个内存状态机"：
1. **没有结算判据。** 子 agent 的最后一条 assistant 消息就是结果。子 agent 若回一句"我先去查一下再回复"，这一轮结束，父会话把它当作最终答案收下。今天子会话拿不到 `subagent` 工具（`childResourceLoaderOptions` 设 `noExtensions: true`），所以这个错误还只发生在"模型提前收工"上；一旦允许嵌套或子会话能调自带委派的 MCP 工具，它就会变成常规故障。
2. **阻塞语义与证据脱钩。** `wait` 是主工具的一个 `action`，脚本（codemode）可以直接调用并丢弃返回值；没有 "committed to the conversation 才算收到结果" 的判据。
3. **主工具混了动词与实现动作。** `run / wait / list / status / stop / doctor` 挤在同一个 `action` 上，且 `action` 是裸 `Type.String()`，非法值靠运行时兜。
4. **不持久化。** 子会话是 `SessionManager.inMemory()`，run 状态在内存里。进程崩溃、会话切换后，跑了一半的 agent 与其已产出的内容全部消失，父会话也不知道有过这回事。
5. **跨扩展通信无协议。** 扩展之间靠 `shared/internal-events.ts` 的字符串 channel 直接广播负载，没有协议版本、没有序号、没有快照语义、没有"载荷里不含什么"的约定。

## Decision

### D1（T0）结算要有判据，中间回答不算结果

- 一个 run 只有在"它的最终消息晚于它欠下的所有结果"之后才算结算。今天没有嵌套，所以欠项集合为空；但**判据必须现在就写进类型**，否则将来加嵌套时会改到所有已有的结算路径。
- 子 agent 的消息若属于"我还在推进，稍后给结果"（无工具调用、无产出、且声明的欠项未结清），状态是 `intermediate`，不是 `idle`。父会话的 `wait` / `list` 对它显示 `intermediate`，不把它当结果收下。
- 结算的证据必须来自会话记录本身（transcript 里那条 assistant 消息），不是内存标志位。`core.ts` 里 `publishSettled` 的输入从"内存 status 变化"改成"从 transcript 派生出的结算判定"。

### D2（T0）唯一的阻塞入口，且只给模型直调

- `wait` 从主工具的 `action` 中独立出来，成为单独的 `subagent_wait`，并标注为模型直调（Pi 的 `exposure: "model-only"`）。理由与 pi-agents 一致：脚本可以丢弃、截断、或在抛错前吞掉返回值，**脚本的 return 不是"模型收到了结果"的证据**。
- `run / send / status / stop` 仍然可被脚本组合（它们是"发起"与"观察"，不依赖证据）。
- `agent` / `action` 等枚举参数一律用 `StringEnum`（`@earendil-works/pi-ai`），不用裸 `Type.String()` + 运行时 `parseAction`。

### D3（T0）诊断从主工具移出

`doctor` 与"跑 agent"没有关系，且它是 `/subagent doctor` 命令的实现。从工具参数面移除，保留命令；工具描述里给一句"要看解析出的 profile 与配置，用 `/subagent doctor`"。

### D4（T1）run 记录持久化与恢复语义

- 每个 run 的生命周期事件（start / settle / failure / stop）用 `pi.appendEntry("pi-kit-subagent-run", …)` 落入父会话记录：`runId`、`agent` profile、`task` 摘要、`status`、最终消息引用（不复制正文）。
- `session_start`（以及会话恢复）时扫描记录，把"上次没有 settle 的 run"列成 `interrupted`，交给人决定 `continue` / `discard`：**子 agent 的会话内容恢复不了，所以恢复的语义只能是"重跑"或"放弃"，不能假装续跑。**
- 不引入 `pi-durable`。恢复的语义按上面这条定，就不是 durable 执行，而是"账本 + 人工重跑"。

### D5（T1）跨扩展事件协议

`shared/internal-events.ts` 从"字符串 channel + 任意负载"升级为一套带协议号的通知：
- 载荷形状：`{ protocol: 1, sessionId?, instanceId, sequence, payload }`。`sessionId` 在发布方知道时带上（同一宿主上多会话并存时据此丢弃别人的事件）。`instanceId` 标识一次扩展生命周期（reload / 会话替换后变化），`sequence` 只在同一 `instanceId` 内递增，**跨 instanceId 不可比较**。
- 快照语义：每次快照**完整替换**上一份，不做增量补丁；消费者可发 `…:state:request` 主动索取当前快照，解决加载顺序与中途 attach。
- 隐私边界：载荷不含 prompt、任务正文、工具参数与结果，只含 id / name / state / closed 这类元数据。
- `stopped` 事件只表示"本进程不再持有 live 状态"，**不表示 durable work 完成**。
- 先落地为 `plan-mode` ↔ `subagent` 这一条真实存在的耦合（`PLAN_MODE_BADGE_CHANNEL` / `PLAN_MODE_STATUS_OWNER_CHANNEL`），再推广到其余 channel。

### D6（T1）Core / Shell 与"从记录派生"

- 视图与真相同源：run / agent 的展示状态、用量、活动行全部从"已提交的记录"派生（纯函数），内存里的可变 state 只做缓存。
- 工具结果里给渲染器的部分（receipt）只装**永远为真**的东西：这次调用碰到哪些 run、看那一刻它们的身份与状态、任务与结果的**长度**、起止时间。不装渲染时算出来的时长、不装实时进度（`step`）、不装 transcript/正文/错误文本，也不装"等待投递中"这类会变的状态。

## Consequences

- `subagent` 的主工具面变小、参数可校验；`wait` 变成独立工具后，`codemode` 脚本不能阻塞等待，脚本编排只能走"发起 + 异步结果"。
- "中间回答"需要模型配合：profile 的 prompt 要说明"结束这一轮等于交付结果，要继续推进就继续调工具"。这条边界写进内置 profile，不然会变成偶发误判。
- 恢复只到"重跑或放弃"，所以 `appendEntry` 里要存 task 摘要，够人做决定即可，不存全量上下文。
- `internal-events.ts` 升级会同时动到现有 channel 的使用方（`plan-mode`、`subagent`、`review-feedback` 等），需要一次性迁移并保留旧 channel 一版。
- 记录派生让视图与恢复路径共用一套纯函数，`core.ts` 的可变状态收缩为缓存；测试可以只喂记录、断言视图。

## Non-goals

- 不引入 `pi-durable` 或任何外部 durable 运行时。
- 不做 agent 自 spawn（有界树的三条界——单次宽度 / 生命周期总量 / 嵌套深度——要先定好才有意义）。
- 不做跨扩展 hooks（`pi-*:hooks:discover` 那套），等有真实外部消费者再谈。
- 不改"子会话不加载扩展"这条隔离（`noExtensions: true`）。
- 不做 agent 之间的点对点消息。

## 实现状态

已落地（2026-11-14）：

| 项                  | 落点                                                                                                                   | 证据                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| D1 结算判据         | `extensions/subagent/settlement.ts` 的 `deriveSettlement`：从 transcript 加欠项算 `settled` / `intermediate` / `empty` | `settlement.test.ts`（8 条）                     |
| D1 中间回答不当结果 | `core.ts` 新增 `intermediate` 终态；`collectWaitResult` 不交付它的正文，`renderWaitResult` 说明为什么没有结果          | `core.test.ts` 的 `intermediate answers`（3 条） |
| D2 唯一阻塞入口     | `subagent_wait` 独立工具，`exposure: "model-only"`；主工具只剩 run/list/status/stop                                    | `index.test.ts`                                  |
| D2 枚举校验         | 主工具 `action` 改用 `StringEnum`，`parseAction` 只做第二道运行时校验                                                  | 同上                                             |
| D3 诊断移出工具面   | `doctor` 从工具参数移除，改走 `/subagent doctor`；`doctor(ctx)` 显式接上下文而不是共享 `lastContext`                   | 同上                                             |

| D4 run 账本 | `extensions/subagent/ledger.ts`：`toLedgerEntry` / `ledgerEntriesOf` / `unsettledRuns` / `renderUnsettled`；接线在 `index.ts` 的 `recordRun`（start / settled / intermediate / failed / stopped，存任务摘要与结果字符数，不存正文） | `ledger.test.ts`（15 条）、`index.test.ts` 的 `run ledger`（4 条） |
| D4 恢复语义 | `session_start` 读记录，把上次没结算的 run 报成一条 warning：会话内容已没了，只能重跑或放弃 | 同上 |

| D5 信封补 `sessionId` | 发布方知道就带上；不知道就不写字段（不写空串） | `event-protocol.test.ts` |
| D1 交付口径统一 | `core.ts` 的 `deliveryFor`：后台投递、前台工具结果、`status`、`list` 四处同一口径，intermediate 的正文不再从任何一条路径当结果出去 | `core.test.ts`、`index.test.ts` |
| D5 事件信封 | `extensions/shared/event-protocol.ts`：`wrapEvent` / `readEvent` / `isFreshEvent` / `createPublisher`；未知 protocol 显式拒绝，裸负载按 legacy 接受一版 | `event-protocol.test.ts`（11 条） |
| D5 首个消费者 | plan-mode ↔ subagent 的两条 channel（badge、status-owner）改用信封，消费者按 instanceId + sequence 丢弃重放/乱序 | `todo-widget.test.ts`、`index.test.ts` 的断言改为读 `payload` |

| D6 receipt | `extensions/subagent/receipt.ts`：`observeRun` / `observeRuns` 只装身份、观察到的状态、任务与结果长度、起止时间；不装 `step`、`lastEventAt`、transcript、结果正文与错误文本 | `receipt.test.ts`（7 条）、`index.test.ts` 的 `receipt`（2 条） |
| D6 接线 | run / list / status / wait / stop 的结构化结果都带 `receipt`（`version: 1`） | 同上 |

| D5 快照语义 | `extensions/shared/event-protocol.ts` 的 `snapshotRequest` / `isSnapshotRequest` / `snapshotRequestChannel` / `SnapshotEnvelope`；`extensions/subagent/state-snapshot.ts` 的 `snapshotOf`：每次发全量、完整替换上一份，只含 id/名字/状态/closed | `state-snapshot.test.ts`（7 条）、`index.test.ts` 的 `state snapshots`（3 条） |
| D5 主动索取 | `pi-kit:subagent:state` + `pi-kit:subagent:state:request`：中途 attach 的消费者发一次索取即拿到当前快照；格式不对的索取被忽略；同一份快照不重发 | 同上 |

视图层（`progressLine` / `renderRunOptions` / `renderWaitResult` / receipt）都已经是从 `SubagentRun` 派生的纯函数；`SubagentRun` 本身仍是内存结构，不是账本记录。把渲染输入换成"账本派生的快照类型"没有做 —— 收益是让恢复到一半的会话也能渲染，而恢复本身现在只到"重跑或放弃"，所以先不做。

## 复核后修正（2026-11-14）

一次两轴 review 找出 9 处与本文不一致的地方，已修并各自留下用例：

| 问题                                                                                 | 修法                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `registerGuard` 按 id 保留首次注册 → reload 后用旧 controller/旧 pi                  | 改为同 id 覆盖                                   |
| `GUARD_STAGE_RANK` key 是 stage id、排序却按 rule                                    | 阶段按 id 排序后再跑，reason 段落顺序随之确定    |
| `intermediate` 只在 `wait` 一条路径被拦                                              | `deliveryFor` 统一四处口径                       |
| 主工具仍留着 `runIds` / `timeoutMs`，`promptGuidelines` 还在教 `action "wait"`       | 参数与文案同步到 `subagent_wait`                 |
| 事件信封缺 `sessionId`                                                               | 补可选字段                                       |
| 收据里装时钟与"不装时钟"冲突                                                         | 正文改成"不装渲染时算的时长"，起止时间明说是事实 |
| `settings` 浅合并会让项目无关键顶掉全局子树                                          | 改深合并                                         |
| shell 结构层超深度静默放行、`-c` 只在独立成词时识别                                  | 报 `unresolved(too-deep)`；按"短选项含 c"识别    |
| 三份死代码（`shell-text.ts`、safe-delete 三个扫描器、bash-block-guard 的旧 handler） | 删除；测试改走真实阶段                           |
