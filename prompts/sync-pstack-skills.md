---

description: 把 skills/pstack/ 对齐到上游 cursor/plugins 的最新版：按内核清单判断哪些差异算 material、按 P0-P3 分级、保住本地适配、跑结构门禁。用法 /sync-pstack-skills [all|<skill ...>] [--report]
argument-hint: "[all|<skill ...>] [--report]"
---

# Sync pstack skills

`skills/pstack/` 是从 [cursor/plugins](https://github.com/cursor/plugins) 的 `harness/pstack` vendored 进来的，本地改过，所以升级靠手工比对。

进口图的是内核，不是文件名：哪条判断值得成为本仓自己的东西，看下一节的清单。

默认中文。作用域是 18 个进口 skill：`principles`（索引 + 24 条叶子）、`blast-radius`、`correct`、`no-comments`、`benchmark-checklist`、`show-me-your-work`、`technical-writing`、`unslop`、`interrogate`、`swarm`、`arena`、`create-verification-skill`、`maintain-verification-skill`、`create-formal-verification-skill`、`maintain-formal-verification-skill`、`ketchup`、`typescript-best-practices`、`sharpen`。参数可以只点名其中几个；`--report` 只出报告，不改文件。

## 真相源

- **对照基准是 `skills/pstack/` 里的真实文件。** README 的 pin 只记「上次同步自哪里」，可能过时，不当 base。
- **适配契约**：下面「内核清单」表，加 `skills/pstack/README.md` 的「包含什么」表（文件级已知适配）。`.pi/plans/` 下的方案文档只当历史记录，不当今天的判据。
- **门禁**：`scripts/pstack-skills.test.ts`。

## 内核清单

pstack 值钱的是一套判断，不是目录结构。左列是内核，右列是它在本仓落到哪——本地已进口的每一行都必须有可见落点，否则就是一句好话。

| 内核                                                     | 上游载体                                                     | 本地落点                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 有名字的判据：先挑一条，再动手                           | `principles/` 24 条叶子                                      | 已 vendor：全文进口，`SKILL.md` 是中文化索引                        |
| 证据优先于自述：留决策轨，不留感慨                       | `show-me-your-work/` 决策 TSV                                | 已本地化：transcript 走 pi session，日志默认中文                    |
| 同一个错犯两遍就改结构：架构 → 类型 → lint → 测试 → 文档 | `correct/`                                                   | 已本地化：规则表落 `AGENTS.md`                                      |
| 删在加之前：注释、死代码、一次性兼容层                   | `no-comments/`                                               | 已 vendor：评审合成两遍走，keep list 逐字保留                       |
| 改动前证影响面：证明那一个事实，不写说明文               | `blast-radius/`                                              | 已 vendor：forge 命令按 remote 选 `gh` / `glab`                     |
| 独立对抗评审：一个 reviewer 一份，父会话裁               | `interrogate/`                                               | 已本地化：`subagent reviewer`                                       |
| 并行分片覆盖：写作任务落不相交目录                       | `swarm/`                                                     | 已本地化：≤4 波次，去 cloud / worktree                              |
| 候选竞争：N 个候选选一作基底，嫁落选者强项               | `arena/`                                                     | 已本地化：候选落 `/tmp` 或 patch                                    |
| 验证流程可生成、可审计、可复跑                           | `create-verification-skill/`、`maintain-verification-skill/` | 已本地化：`.pi/skills/verify-<app>/`                                |
| 测试盖不到的用例交给形式化：选最强那条承诺，让问题挑工具，必须见过它失败 | `create-formal-verification-skill/`、`maintain-formal-verification-skill/` | 已本地化：`.pi/skills/verify-<area>-formal/`，反例讲成代码里的最短路径，画图走 Mermaid |
| 人读文字两把刀：分层写作标准 + 去 AI 腔                  | `technical-writing/`、`unslop/`                              | 已 vendor，各带中文补充段                                           |
| 报数字前先解释数字：先找限速因素                         | `benchmark-checklist/`                                       | 已 vendor，正文未改                                                 |
| 报进度给不在场的人：只列他必须决定的，每条带证据与风险   | `ketchup/`                                                   | 已本地化：对话里的图指 `/show-me`，通知与 subagent 结果不算用户消息 |
| 类型挡在运行时之前：坏状态写不出来                       | `typescript-best-practices/`                                 | 已 vendor：去 `paths:`，接 `type-system-discipline` 原则            |
| 做深不做大：先问专业做法与原始材料，再重写任务           | `sharpen/`                                                   | 已 vendor，正文未改                                                 |
| 复盘落在环境上：三镜头、三桶、逐条落点                   | `reflect/`（未进口）                                         | 已并入 `skills/retro/SKILL.md`，不单独进口                          |

**不 vendor** 的是上游 harness，不是内核：Task 参数名、`pstack-models` 规则与 model slug、`AskUserQuestion`、`TodoWrite`、`.cursor` 路径、playbook 内的 harness 段（playbook 内容本身已进口到 `skills/poteto-playbooks/`，逐文件判定见 `scripts/poteto-kernel-map.json`）、Claude Code adapter 段、`poteto-mode`（本地入口是 `prompts/poteto.md`）、云端隔离与 worktree 并发写。

**判据**：上游差异只有落在「已 vendor / 已本地化」的行上才算 material，进第 4 步分级；落在不 vendor 项上的一行带过。表外冒出新内核时，报告里写三行——是什么、上游怎么用、本地缺什么落点——然后问人「要不要 vendor 进来」，不自动进口。

`reflect/` 那行是「并入」不是「进口」：它和本地 `retro` 同题，只搬机制，`skills/pstack/` 下没有目录，所以第 2 步对不到文件。

## 1 解析 target

按顺序取第一条成立的：
1. `git ls-remote --tags https://github.com/cursor/plugins` 有标签 → 最新标签指向的 commit。
2. 没有标签 → 上游 `harness/pstack/claude-code/plugin.json` 的 `version`，配 HEAD commit。
3. 版本没变但 HEAD 前进 → 照比，上游可能改了正文没改版本。

```bash
rm -rf /tmp/pstack-upstream
git clone --filter=blob:none --sparse https://github.com/cursor/plugins /tmp/pstack-upstream
git -C /tmp/pstack-upstream sparse-checkout set harness/pstack
git -C /tmp/pstack-upstream log -1 --format='%H %ad %s' --date=short
```

完成判据：手上有 target 的 version 与 commit。

## 2 本地对上游，逐文件比

叶子的差异只允许三类改写：删 frontmatter、`../principle-x/SKILL.md` → `x.md`、`../<skill>/SKILL.md` → `/skill:<skill>`；另允许删掉 `In Claude Code, read [the Claude Code adapter]` 那一整段。归一化后必须逐字相同。

```bash
cat > /tmp/pstack-normalize.py <<'PY'
import pathlib, re, sys

body = pathlib.Path(sys.argv[1]).read_text()
if body.startswith("---\n"):
    body = body.split("\n---\n", 1)[1]
body = re.sub(r"\.\./principle-([a-z0-9-]+)/SKILL\.md", r"\1.md", body)
body = re.sub(r"\.\./([a-z0-9-]+)/SKILL\.md", r"/skill:\1", body)
body = re.sub(r"^In Claude Code, read \[the Claude Code adapter\].*\n", "", body, flags=re.M)
body = re.sub(r"\n{3,}", "\n\n", body)
print(body.strip())
PY

for f in skills/pstack/principles/references/*.md; do
  id=$(basename "$f" .md)
  diff -q <(python3 /tmp/pstack-normalize.py "/tmp/pstack-upstream/harness/pstack/claude-code/skills/principle-$id/SKILL.md") \
          <(python3 /tmp/pstack-normalize.py "$f") >/dev/null || echo "DRIFT $id"
done
```

其余 14 个 `SKILL.md` 用整文件 diff 起手，再读两边全文：

```bash
for s in blast-radius correct no-comments benchmark-checklist show-me-your-work technical-writing unslop interrogate swarm arena create-verification-skill maintain-verification-skill create-formal-verification-skill maintain-formal-verification-skill ketchup typescript-best-practices sharpen; do
  echo "== $s"
  diff -u "/tmp/pstack-upstream/harness/pstack/claude-code/skills/$s/SKILL.md" "skills/pstack/$s/SKILL.md"
done
```

带 `references/` 的三个（`interrogate`、`create-verification-skill`、`typescript-best-practices`）再 `diff -rq` 一遍，确认子文件没漏。

整文件 diff 会带上已知适配，这是预期。只判断一件事：diff 里有没有**内核清单之外**的上游新规则。

`principles/SKILL.md` 没有上游对应物，是本地索引；它只在叶子增删时跟着改 bullet。

完成判据：每个文件都归入「只剩已知适配」或「有未知差异」。

## 3 没有未知差异就停

未知差异为 0：输出 `no material change: local matches <version> (<sha>)`，跑门禁（第 7 步），停。不要为了交差编一条升级。

## 4 分级

| 级别 | 判据                                                        | 本组例子                                                                 |
| ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| P0   | 适配契约（内核清单）被上游改写；原则 id 增删；新增/删除原则 | 上游删掉 `blast-radius` 的「证明那一个事实」；上游新增一条 `principle-*` |
| P1   | 正文规则变化，会改变行为                                    | `no-comments` 的 keep list 多一类或少一类注释                            |
| P2   | 措辞收紧，行为不变                                          | 同一句改短；表格重排                                                     |
| P3   | 链接、编码、格式                                            | principle 链接的写法变了                                                 |

冲突只有一个定义：上游改的正是本地改过的那一段。冲突文件停下问人，其余继续。

## 5 报告

先出表，每行一个文件：

| 文件 | 上游改了什么 | 本地适配 | 级别 | 动作 |

`本地适配` 取：无 / 保留 / 需扩展 / 冲突。`--report` 到此为止。

## 6 合并

逐文件三步：
1. 读本地全文，标 `[PI]`：frontmatter（`disable-model-invocation: true`，`principles` 例外）、中文补充段、`/skill:` 路由、gh/glab 双写、plan 评审门、中文日志。
2. 读上游全文，标 `[UPSTREAM]`：新增的结构单元与规则。
3. 只搬不冲突的 `[UPSTREAM]`。冲突以 `[PI]` 为准，并写进报告。

不搬「内核清单」标为不 vendor 的 harness 项（Task 参数名、`pstack-models`、model slug、`AskUserQuestion`、`TodoWrite`、`.cursor` 路径、playbook 内的 harness 段、adapter 段、`poteto-mode`）。写委派改写成 `subagent` profile。playbook 内容与不进口清单以 `scripts/poteto-kernel-map.json` 为准，先跑 `node scripts/poteto-kernel-gap.mjs --check` 再动手。

叶子按第 2 步的三类改写搬正文，不加 frontmatter。

## 7 验证

两条都要跑，贴输出：

```bash
# 期望 0 行 DRIFT
for f in skills/pstack/principles/references/*.md; do
  id=$(basename "$f" .md)
  diff -q <(python3 /tmp/pstack-normalize.py "/tmp/pstack-upstream/harness/pstack/claude-code/skills/principle-$id/SKILL.md") \
          <(python3 /tmp/pstack-normalize.py "$f") >/dev/null || echo "DRIFT $id"
done

npx vitest run scripts/pstack-skills.test.ts
```

门禁必须全绿（当前 18 passed）。增删原则时，索引 bullet、`references/` 文件、测试里的 `24` 要一起改。

只有 skill 集合变了（新增、删除、改名）才需要重装：

```bash
./skills/migrate.sh import
ls -l ~/.agents/me-skills/<name> .pi/skills/<name>
```

两条链接的 target 都要存在。

## 8 收尾

- 更新 `skills/pstack/README.md` 第 3 行的版本、commit、vendored 日期。
- 更新 `skills/skills.txt` 的 `v<version> @ <sha>` 注释。
- commit：`chore(skills): sync pstack to <version> (<sha>)`。
- 回一句：用 `/poteto` 的人会看到什么变化；没变就说没变。
- 改了这个 prompt 自己，`~/.pi/agent/prompts/` 下是 copy 不是链接，`cp prompts/sync-pstack-skills.md ~/.pi/agent/prompts/` 后才生效。

## 约束

- 不改 `disable-model-invocation`：除 `principles` 外都是 `true`。
- `name` 等于目录名；上游改名不跟。
- 不把 `principle-*` 拆成顶层 skill。
- 不改「`git remote -v` 决定 gh 还是 glab」这条判据。
- 上游新增 skill 只报告，不顺手导入：需要云隔离、worktree 并发写的先不进口；只读多模型评审按 P3 的 C′ 处理。
- 不为了对齐上游删本地适配；删一条要在报告里写理由。
