# pstack 进口组

来源：[`cursor/plugins`](https://github.com/cursor/plugins) 的 `harness/pstack`，插件版本 `0.15.32`，commit [`e73df47`](https://github.com/cursor/plugins/commit/e73df471cd4bd918367e99f3dd9c51bd53ddf5f0)，2026-10-22 vendored，2026-10-27 对 `0.15.32` 复核：本组 16 个 skill 与上游无内核差异，只有 `swarm` 的步骤编号与一处措辞变化（P2/P3），本地已是等价写法。

逐条适配见下表。升级判据不是上游文件本身，是 [`prompts/sync-pstack-skills.md`](../../prompts/sync-pstack-skills.md) 的「内核清单」：内核必须在本仓有落点，harness 绑定不进口。2026-10-21 的适配更新（`subagent`、C′）见 [`.pi/plans/pi-kit/specs/2026-10-21-pstack-adoption-adaptation.md`](../../.pi/plans/pi-kit/specs/2026-10-21-pstack-adoption-adaptation.md)。

## 包含什么

| 目录 | 状态 |
|---|---|
| `principles/` | 24 条原则：`SKILL.md` 是索引，`references/<id>.md` 是上游叶子全文 |
| `blast-radius/` | 改过一次：删多模型 `arena`，forge 命令按 remote 选 `gh` / `glab` |
| `correct/` | 改过一次：规则表落到 `AGENTS.md`，forge 命令按 remote 选 |
| `no-comments/` | 改过一次：评审合成单文件两遍走（先出表再改），keep list 与抑制判断逐字保留，补 Go / shell 的抑制写法 |
| `benchmark-checklist/` | 正文未改，逐字进口 |
| `show-me-your-work/` | 改过一次：transcript 路径改 pi session，跨模型复核改只读 squad 可选，日志默认中文；`scripts/log.sh` 与 TSV 模板一并搬入 |
| `technical-writing/` | 改过一次：去 adapter，PR/MR 措辞，开头写清与 `unslop`、`writing-for-agents` 的边界 |
| `unslop/` | 正文未改，只是搬进本组 |
| `interrogate/` | 改过一次：评审改 `subagent reviewer`，删 Task 参数名、上游模型规则与 slug 回退；references 原样搬入 |
| `swarm/` | 改过一次：去 cloud / worktree，改 ≤4 波次；写任务只落不相交目录 |
| `arena/` | 改过一次：候选写 `/tmp` 或 patch，去 worktree 与 per-model runners |
| `create-verification-skill/` | 改过两次：`.pi/skills/verify-<app>/`；drive 先找仓库已有 harness，再用 pi 工具；references 一并搬入；生成物不加 `disable-model-invocation`，生成后要求 `/reload` |
| `maintain-verification-skill/` | 改过一次：源波改 `subagent explore`，4 个一波；PR 按 remote 选 `gh` / `glab` |
| `ketchup/` | 改过一次：去 `/bro` 与 `/visualize` 依赖，对话里的图改指 `/show-me`，通知与 subagent 结果不算用户消息 |
| `typescript-best-practices/` | 改过一次：去 `paths: ["**/*.ts"]`（pi 没有按路径自动挂载），原则引用改本地写法；`references/patterns.md` 除首行外逐字进口 |
| `sharpen/` | 正文未改，只译成中文 |

入口 `/poteto` 不在这里，是 [`prompts/poteto.md`](../../prompts/poteto.md)。

## 升级上游

入口是 `/sync-pstack-skills`（[`prompts/sync-pstack-skills.md`](../../prompts/sync-pstack-skills.md)）：它读上游最新版、逐文件比对本地、分级、跑结构门禁。下面的三步保留作手工兜底。

上游没有直接可用的 git remote 订阅方式，且本组改过 frontmatter 与正文。升级按手工 diff：

1. 按 pin 的 commit 拉上游：

   ```bash
   git clone --filter=blob:none --sparse https://github.com/cursor/plugins /tmp/cursor-plugins
   git -C /tmp/cursor-plugins checkout e73df471cd4bd918367e99f3dd9c51bd53ddf5f0
   git -C /tmp/cursor-plugins sparse-checkout set harness/pstack/claude-code/skills
   ```

2. 对比 `principles/references/` 的 24 个文件。
3. 只把叶子正文变化搬过来，保留本仓的链接改写（`../principle-x/SKILL.md` → `x.md`）。

## 删掉整组

```bash
# 1. 去掉 skills/skills.txt 里本组十六行
# 2. 重建链接，清掉 me-skills 中不再被引用的条目
./skills/migrate.sh import
# 3. 删源码与入口
rm -rf skills/pstack prompts/poteto.md
# 4. 删掉 .pi/skills 下的悬空链接
find .pi/skills -maxdepth 1 -type l ! -exec test -e {} \; -delete
```
