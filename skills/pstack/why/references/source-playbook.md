# 来源 playbook 索引

`why` 每个可用来源派一个调查者，每个调查者读一份对应的方法文件。下面的表把来源类别映射到本机
可用的工具。换工具时按同一类别改编，不要新造类别。

## 两种「没有」必须分开

综合者的 `Sources Consulted` 里，每个源只有三种状态，措辞不能混：

| 状态 | 含义 | 措辞 |
| --- | --- | --- |
| **查到了** | 检索过，有结果 | 写明查了什么、找到什么 |
| **查了没有** | 检索过，无结果 | `searched, nothing found` + 具体查询词与范围 |
| **本机没有** | 环境里没有这个源，**没检索过** | `not available in this environment` + 缺什么 |

把第三种写成第二种，等于宣称做过一次没做过的检索。这是本 skill 要防的主要错误。

`searched, nothing found` 必须带查询词。「查了工单，没有」不合格；「在工单里搜了
`rate limit`、`throttle`、`429`，最近 24 个月，无匹配」合格。

## 可用来源表

探测方式见 `SKILL.md` 第二节。缺席的源照样在 `Sources Consulted` 里占一行，写第三种状态。

**两层都要探：装没装，以及凭据配没配。** 目录在但凭据没配时，脚本会直接报鉴权失败——
那对这个源来说等于「本机没有」，不是「查了没有」。

| 类别 | 方法文件 | 本机工具 | 前置条件 | 层 |
| --- | --- | --- | --- | --- |
| 源码史 | [`sources/code-archaeology.md`](sources/code-archaeology.md) | `git`、`gh` / `glab`（按 `git remote -v` 选） | forge CLI 已登录 | 通用 |
| 本地笔记 / 知识库 | [`sources/local-notes.md`](sources/local-notes.md) | `qmd` CLI | 索引覆盖相关目录 | 通用 |
| 长文档 | [`sources/confluence.md`](sources/confluence.md) | `confluence_page`（**只能父会话调**） | `ATLASSIAN_PAT` | 通用但父查 |
| 工单 | [`sources/jira.md`](sources/jira.md) | `jira` CLI；`confluence_page` 返回的 jiraKeys | CLI 已登录 | 可选 |
| 可观测 | [`sources/observability.md`](sources/observability.md) | `metric-analysis`、`log-analysis`、`service-change-timeline` | Grafana / log 各自的凭据 | 可选 |
| 错误追踪 | [`sources/error-tracking.md`](sources/error-tracking.md) | `trace-analysis`、`log-analysis` | trace / log 各自的凭据 | 可选 |
| 数仓 | [`sources/warehouse.md`](sources/warehouse.md) | `datastudio-hive-query`；`abtest` MCP（**只能父会话调**） | `DATASUITE_PERSONAL_TOKEN` | 可选 |
| 群聊 | **不进口** | 本机没有 | — | 无 |

### 为什么群聊不进口

上游为此单独有一份 `slack.md`。本机没有群聊证据源，所以这一行只在这里占位：它在
`Sources Consulted` 里永远写 `not available in this environment`。不要为它派调查者，也不要把它
写成「查了没有」。将来接上群聊源时再补一份方法文件。

### 父查 vs 子派

子会话的工具是 `read` / `grep` / `find` / `ls` / `edit` / `write` / `bash`——**没有
`confluence_page`，没有 `qmd_*`，没有 `mcp__*`**。所以：

- **子派**：只要能用 `bash` 或直接读文件就够的源。源码史、本地笔记（`qmd` 有 CLI）、以及
  `~/.agents/skills/` 下那些自带 `fetch-*.sh` 的可选源。
- **父查**：只有 `confluence_page` 或 MCP 能拿到的源。父会话查一次，把结论**当作锚点的一部分**
  发给调查者，并在 `Sources Consulted` 里注明是父会话查的。

不要为了把一个源派给子会话而打开 MCP 继承：子会话的 MCP transport 不被 `session.dispose()`
关掉，`pi --print` 下进程不退出。

## 追加：事故口味的查询

[`sources/incident-postmortem.md`](sources/incident-postmortem.md) 不是独立类别，是**叠加**在某个源
上的查询口味。目标代码看起来像防御性代码时（null 检查、重试、超时、限流、feature flag、
egress guard、OOM 处理），把它接到那个调查者的 prompt 后面。

## 派发规则

- **一个调查者只负责一个源**，不要让它覆盖多个。跨源的线索记进它的 Additional Leads。
- 所有调查者同一条消息里发出（`subagent`，`agent: "general"`，`background: true`），
  一次 `subagent action: "wait"` 收。
- **默认全量派**。覆盖地图比省几个子会话值钱。**查不到就记下查不到，不要跳过检索。**
- 唯一可以少派的判断：目标是一次单 commit 的琐碎改动，PR 描述已含完整答案，且确认所有可用源都
  会重复。这种情况很少见，且要明说。
