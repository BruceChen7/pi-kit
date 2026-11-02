# pstack 进口组

来源：[`cursor/plugins`](https://github.com/cursor/plugins) 的 `harness/pstack`，插件版本 `0.15.36`，commit [`ae5650f`](https://github.com/cursor/plugins/commit/ae5650febf4320793844c12c4adaa937f417f8da)，2026-10-22 vendored；2026-10-27 复核 `0.15.32` 无内核差异，同日按用户点名进口形式化验证一对；2026-10-29 同步到 `0.15.36`：`explain-the-number` 补「跑之前先写下会改变决策的结果」，`arena` 补座位与 judge 两条规则（跨族判据本地不要），`interrogate` 按上游重写成「run 证伪」并删掉那 4 份 references；2026-11-02 复核 `0.15.36` 正文与 `1ba91fc` 逐字节相同（`ae5650f` 只动了别的插件），同轮按用户点名进口 `why`、`how`、`recall`、`figure-it-out` 四个，并把 `architect` 的两份判断清单并进 `codebase-design/`。

逐条适配见下表。升级判据不是上游文件本身，是 [`prompts/sync-pstack-skills.md`](../../prompts/sync-pstack-skills.md) 的「内核清单」：内核必须在本仓有落点，harness 绑定不进口。2026-10-21 的适配更新（`subagent`、C′）见 [`.pi/plans/pi-kit/specs/2026-10-21-pstack-adoption-adaptation.md`](../../.pi/plans/pi-kit/specs/2026-10-21-pstack-adoption-adaptation.md)。

## 包含什么

| 目录 | 状态 |
|---|---|
| `principles/` | 24 条原则：`SKILL.md` 是索引，`references/<id>.md` 是上游叶子全文 |
| `blast-radius/` | 改过一次：删多模型 `arena`，forge 命令按 remote 选 `gh` / `glab` |
| `correct/` | 改过一次：规则表落到 `AGENTS.md`，forge 命令按 remote 选 |
| `no-comments/` | 改过一次：评审合成单文件两遍走（先出表再改），keep list 与抑制判断逐字保留，补 Go / shell 的抑制写法 |
| `benchmark-checklist/` | 改过一次：本地自加 `## A table you choose from`（本地 `8bfe49a`，上游任何 ref 都搜不到这节）：选型表每行自带走数证据级（`runs=3` / `runs=1` / `未测`），选型句只能引跑过的行 |
| `show-me-your-work/` | 改过一次：transcript 路径改 pi session，跨模型复核改 `subagent` + `.pi/agents/` 里 pin 了 `model` 的 profile（没有该 profile 就同模型再跑一遍并写明），日志默认中文；`scripts/log.sh` 与 TSV 模板一并搬入 |
| `technical-writing/` | 改过一次：去 adapter，PR/MR 措辞，开头写清与 `unslop`、`writing-for-agents` 的边界 |
| `unslop/` | 正文未改，只是搬进本组 |
| `interrogate/` | 2026-10-29 按上游重写：一条 finding 要用一次 run 证伪、父会话复现后才留下，fan-out 复用 `arena` 的 A 阶段 3/4 步与 B 阶段，跳过 arena 的 C/D/E；对抗者改 `subagent general` 跑在 `/tmp/interrogate-<slug>/adversary-<n>/`（只读 profile 没有 bash，跑不了 repro），未提交改动只进副本；上游删掉的 4 份 references 本地一并删除 |
| `swarm/` | 改过一次：去 cloud / worktree，改 ≤4 波次；写任务只落不相交目录 |
| `arena/` | 改过两次：候选写 `/tmp` 或 patch，去 worktree 与 per-model runners；2026-10-29 按上游补两条——座位派不出去要补满候选，judge 有别的模型就换、派不出就跳过（不强制跨族，本地模型少） |
| `create-verification-skill/` | 改过两次：`.pi/skills/verify-<app>/`；drive 先找仓库已有 harness，再用 pi 工具；references 一并搬入；生成物不加 `disable-model-invocation`，生成后要求 `/reload` |
| `maintain-verification-skill/` | 改过一次：源波改 `subagent explore`，4 个一波；PR 按 remote 选 `gh` / `glab` |
| `create-formal-verification-skill/` | 2026-10-27 进口。改过：生成物落 `.pi/skills/verify-<area>-formal/`，不加 `disable-model-invocation`，要求 `/reload`；去 adapter 段；`/statechart` 换成「反例讲成代码里的最短路径，画图用 `validate_mermaid` / `render_mermaid`」 |
| `maintain-formal-verification-skill/` | 2026-10-27 进口。改过：按「跑模型检查器的项目级 skill」找目标，不看名字；PR 按 remote 选 `gh` / `glab`；去 adapter 段 |
| `ketchup/` | 改过一次：去 `/bro` 与 `/visualize` 依赖，对话里的图改指 `/show-me`，通知与 subagent 结果不算用户消息 |
| `typescript-best-practices/` | 改过一次：去 `paths: ["**/*.ts"]`（pi 没有按路径自动挂载），原则引用改本地写法；`references/patterns.md` 除首行外逐字进口 |
| `sharpen/` | 正文未改，只译成中文 |
| `why/` | 2026-11-02 进口。改过：去 harness 段与 model slug；来源 playbook 按本机工具重写（`linear`→`jira`、`notion`→`confluence`、`datadog`→`observability`、`sentry`→`error-tracking`、`databricks`→`warehouse`），新增 `local-notes`（qmd CLI）；`slack` 不进口，改成来源表里的一行 gap；新增「探源」步与两种 gap 的措辞纪律；调查者用 `subagent general`（要 bash 取证，MCP 与 `confluence_page` 由父会话查） |
| `how/` | 2026-11-02 进口。改过：去 harness 段与 model slug；派探查者改 builtin `explore`；`Read/Grep/Glob` → `read`/`grep`/`find`；mermaid 段改指 `validate_mermaid` / `render_mermaid` |
| `recall/` | 2026-11-02 进口。改过：去 harness 段；transcript 路径由 Cursor 的 `agent-transcripts/` 改为 pi session 公式（与 `show-me-your-work` 一致）；共享记录扫描复用 `/skill:why` 的来源调查者；`session-pickup` playbook 改指 `/skill:handoff` |
| `figure-it-out/` | 2026-11-02 进口。改过：去 harness 段与上游入口引用；`architect` 改指 `/skill:codebase-design` 和它的 `DESIGN-RED-FLAGS.md`；worktree 隔离改 `/tmp` 或 patch；段落分隔符统一 |

入口 `/poteto` 不在这里，是 [`prompts/poteto.md`](../../prompts/poteto.md)。

`architect` 没有独立目录：它的设计候选探索已由 [`codebase-design/DESIGN-IT-TWICE.md`](../../skills/codebase-design/DESIGN-IT-TWICE.md) 覆盖，真缺的两份判断清单（8 条红旗 + 6 条「架构错了」的 tell）落在 [`codebase-design/DESIGN-RED-FLAGS.md`](../../skills/codebase-design/DESIGN-RED-FLAGS.md)。

## 升级上游

入口是 `/sync-pstack-skills`（[`prompts/sync-pstack-skills.md`](../../prompts/sync-pstack-skills.md)）：它读上游最新版、逐文件比对本地、分级、跑结构门禁。下面的三步保留作手工兜底。

上游没有直接可用的 git remote 订阅方式，且本组改过 frontmatter 与正文。升级按手工 diff：

1. 按 pin 的 commit 拉上游：

   ```bash
   git clone --filter=blob:none --sparse https://github.com/cursor/plugins /tmp/cursor-plugins
   git -C /tmp/cursor-plugins checkout 1ba91fc25c0977741dd0e267849e6234b037ed0a
   git -C /tmp/cursor-plugins sparse-checkout set harness/pstack/claude-code/skills
   ```

2. 对比 `principles/references/` 的 24 个文件。
3. 只把叶子正文变化搬过来，保留本仓的链接改写（`../principle-x/SKILL.md` → `x.md`）。

## 删掉整组

```bash
# 1. 去掉 skills/skills.txt 里本组十八行
# 2. 重建链接，清掉 me-skills 中不再被引用的条目
./skills/migrate.sh import
# 3. 删源码与入口
rm -rf skills/pstack prompts/poteto.md
# 4. 删掉 .pi/skills 下的悬空链接
find .pi/skills -maxdepth 1 -type l ! -exec test -e {} \; -delete
```
