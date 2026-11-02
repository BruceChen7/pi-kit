---
name: why
description: "查一段代码为什么是现在这个形状：设计动机、取舍、被放弃的方案、某个阈值的来历。按可用证据源并行取证，结论按置信分层，并说清哪些查不到。Use when 用户问「为什么这么写」「为什么选 Y」「这个数字哪来的」、要查设计动机、回归原因、事后复盘，或要一份带引用的历史结论。查运行时行为用 /skill:how。"
disable-model-invocation: true
---

# Why

查代码背后的动机与意图。运行时行为归 `/skill:how`；`why` 查「是什么力量把它变成现在这个形状」。

默认中文交付。命令、输出、`file:line`、引文原样保留。

不要用代码本身当它自己意图的证据。代码说明它是什么，不说明它为什么这样。动机活在 commit、PR、工单、文档和对话里。

## 姿态

做一个**谨慎、精确的调查者**。分清「我知道」与「我推断」。写之前读一遍 [`references/epistemics.md`](references/epistemics.md)：那里是完整的置信框架与措辞纪律，综合者必须照它合成。

## 一、确认对象与问题

**对象**通常是一段代码、一个模式、一个功能，或一个有名字的设计决定。**问题**通常是设计动因、取舍、当初要解决的边界情况、外部约束、死代码的来历，或一段历史。

对象含糊时（「我们为什么这么做」没有明确指代），从本对话上下文里取最可能的理解，一句话说明你的理解让他能纠正，然后继续。

## 二、探源：先弄清本机有哪些证据源

派调查者之前先探源。**这一步的结果决定后面派谁**，不能跳。

按存在性探测，不靠猜：

```bash
# 通用源，总在
command -v git >/dev/null && echo "source-control: git"
command -v gh >/dev/null && echo "source-control: gh"
command -v glab >/dev/null && echo "source-control: glab"
command -v qmd >/dev/null && echo "local-notes: qmd"
command -v jira >/dev/null && echo "optional: jira-cli"

# 可选源：目录在只说明装了 skill。源能不能用还取决于凭据，
# 所以凭据也要探一次，否则会把「装了但没配」当成「查了没有」。
for s in metric-analysis log-analysis trace-analysis service-change-timeline datastudio-hive-query; do
  [ -d "$HOME/.agents/skills/$s" ] && echo "installed: $s"
done

cfg="$HOME/.config/cursor_config_be/.env"
have() { env | grep -q "^$1=" || grep -qs "^$1=" "$cfg"; }
have GRAFANA_API_CONFIG    && echo "credential: grafana (metric-analysis)"
have LOG_LOG_CONFIG        && echo "credential: log api (log-analysis)"
have TRACE_LOG_CONFIG      && echo "credential: trace api (trace-analysis)"
have EVENT_TIMELINE_BASE_URL && echo "credential: event timeline (service-change-timeline)"
have DATASUITE_PERSONAL_TOKEN && echo "credential: datasuite (datastudio-hive-query)"
have ATLASSIAN_PAT         && echo "credential: atlassian (confluence_page)"
```

**装了不等于能用。** 目录在、凭据没配时，这个源对本次调查是「本机没有」，不是「查了没有」——
脚本会直接报鉴权失败。探源要把两层都探到，缺哪层写哪层。

三层来源，缺席时说法不同：

| 层 | 源 | 怎么查 | 缺席怎么写 |
| --- | --- | --- | --- |
| 通用 | 源码史 | `git`、`gh` / `glab`（按 `git remote -v` 选） | 不该缺席；缺席就是环境问题，直说 |
| 通用 | 本地笔记 / 知识库 | `qmd` CLI（还要看索引里有没有覆盖相关目录） | `not available in this environment` |
| 通用但父查 | Confluence | `confluence_page`（子会话没有这个工具，父会话查完把结论当锚点发下去）；还要 `ATLASSIAN_PAT` | `not available in this environment` |
| 可选 | 工单 | `jira` CLI；或 `confluence_page` 返回的 jiraKeys（`prompts/chat-to-jira.md` 是往 Jira 里写，不是读） | `not available in this environment` |
| 可选 | 可观测 | `metric-analysis`（要 Grafana 凭据）、`log-analysis`（要 log 凭据）、`service-change-timeline` | `not available in this environment` |
| 可选 | 错误追踪 | `trace-analysis`、`log-analysis`（两者都要各自的凭据） | `not available in this environment` |
| 可选 | 数仓 | `datastudio-hive-query`（要 `DATASUITE_PERSONAL_TOKEN`）、`abtest` MCP（MCP 由父会话查） | `not available in this environment` |
| 无 | 群聊 | 本机没有 | `not available in this environment` |

**两种「没有」必须分开写**，这是这份 skill 的核心纪律：

- **本机没有这个源** → `not available in this environment`。这是**环境事实**，不是检索结果。
- **有这个源，查了没查到** → 写出具体检索词与范围，例如「在工单里搜了 A、B、C，最近 12 个月，无匹配」。

把前者写成后者，等于宣称做过一次没做过的检索。这是本 skill 要防的主要错误。

逐来源的检索方法见 [`references/source-playbook.md`](references/source-playbook.md)。

## 三、建代码锚点

派调查者之前，先在本会话内建好种子上下文。这些要发给每个调查者和综合者：

- 文件路径与行范围、关键符号（函数、类、常量）
- 最近碰过这段代码的若干 commit
- commit message 里的 PR 号（`(#1234)` 形态）与工单号
- 相关的 `file:line`

```bash
git blame -L <start>,<end> <file>          # 最后改动
git log --follow -p -- <file>             # 全历史，跟过改名
git log --oneline -20 -- <file>           # 最近提交，能看到 PR 号
git log -1 --format=%B <commit>            # 取 PR 号
```

拿到 PR 号就去拉正文与讨论（`gh pr view <n>` 或 `glab mr view <n>`，按 `git remote -v` 选）。

## 四、派并行调查者

**默认全量并行**。目标是覆盖地图，不是最小集。**查不到就记下查不到，不要跳过检索。**

按第二层探到的源，一个源一个调查者，同一条消息里一起发出去（`subagent`，`agent: "general"`，`background: true`），收的时候一次 `subagent action: "wait"`。

- **一个调查者只负责一个源。** 不要让一个调查者覆盖多个源；交叉引用记进它的 Additional Leads，由对应源的调查者跟进，不要自己去追。
- **要有 bash 权限**：取证要跑 `git`、`gh`/`glab`、`qmd` 和 `fetch-*.sh`。隔离靠「不写文件」，不靠只读 profile。子会话看不到本对话，`task` 必须自包含。
- 每个调查者的 prompt 是 [`references/investigator-prompt.md`](references/investigator-prompt.md) 填好，加上它的源对应的方法节、代码锚点、用户的原始问题。
- 目标代码看起来像防御性代码（null 检查、重试、超时、限流、feature flag、OOM 处理）时，额外加「事故口味的查询」那一节。

调查者只收集原始材料，不下结论、不选边。综合由下一步做。

## 五、综合

派一个综合者（`subagent`，`agent: "general"`）。给它：

1. 所有调查者的产出，含 null 结果与每个源的状态
2. 代码锚点
3. 用户的原始问题
4. [`references/epistemics.md`](references/epistemics.md) 的全文
5. [`references/synthesizer-prompt.md`](references/synthesizer-prompt.md) 的模板

综合者按五档置信合成，逐条校准措辞。

## 六、呈现

把综合者的输出交给用户。可以为清楚起见轻度编辑，**但不要重写它的置信措辞**。

输出结构（细节见 `references/synthesizer-prompt.md`）：

1. **The Question** — 一两句话复述问题。
2. **The Code in Question** — 路径、行范围、关键符号。
3. **What We Found** — 直接证据，逐条带引用。`[Direct]` 是单一来源的显式证据，`[Supported]` 是多项间接证据收敛。
4. **What We Can Reasonably Infer** — 用 hedge 措辞，且把推断链写出来。
5. **Competing Hypotheses** — 证据支持多个故事时就都列出来，每条写「支持它什么」「缺什么」。
6. **What We Don't Know** — 具体缺口。写「在 X 里搜了 Y、Z，没有」，不写「我们不知道」。
7. **Sources Consulted** — 每个源一行，**包括返回空的和跳过的**，并写明是「本机没有」还是「查了没有」。
8. **Confidence Summary** — 一两句总置信度。

`Sources Consulted` 之后，如果这个问题是改这段代码的前置，把结论转成一组约束供计划使用：**Preserve / Change / Avoid / Risk**。

## 要避免的失败模式

- **近因偏差**：假定最近的 commit 最权威。现在的形状常是许多更早决定的堆积，往前追。
- **用代码推意图**：「作者选了函数式写法」是对代码的观察，不是意图的证据。只引用作者写下来的意图。
- **确认用户猜测**：用户常把假设塞进问题（「我猜这是为了性能？」）。那是检索的线索，不是结论。独立取证后再说。
- **把缺失当不存在**：「没人提过安全问题，所以当时不担心」是把没有证据当成不存在的证据。
- **为了显得果断而抹平不确定**：证据矛盾就把两边都列出来。
- **填满缺口**：一个诚实的「不知道」比一个听起来对的猜测有用得多，后者会被拿去行动。

## 边界

- 只调查与呈现，**不改代码**。
- 没有引用的结论不进 `What We Found`。
- 不把「本机没有这个源」写成「查过没有」。
- 不把一次检索包装成完整覆盖；`Sources Consulted` 照实写。
