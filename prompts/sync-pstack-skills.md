---
description: 把 skills/pstack/ 对齐到上游 cursor/plugins 的最新版：本地文件逐条比对上游、按 P0-P3 分级、保住本地适配、跑结构门禁。用法 /sync-pstack-skills [all|<skill ...>] [--report]
argument-hint: "[all|<skill ...>] [--report]"
---
# Sync pstack skills

`skills/pstack/` 是从 [cursor/plugins](https://github.com/cursor/plugins) 的 `harness/pstack` vendored 进来的，本地改过，所以升级靠手工比对。

默认中文。作用域是 13 个进口 skill：`principles`（索引 + 24 条叶子）、`blast-radius`、`correct`、`no-comments`、`benchmark-checklist`、`show-me-your-work`、`technical-writing`、`unslop`、`interrogate`、`swarm`、`arena`、`create-verification-skill`、`maintain-verification-skill`。参数可以只点名其中几个；`--report` 只出报告，不改文件。

## 真相源

- **对照基准是 `skills/pstack/` 里的真实文件。** README 的 pin 只记「上次同步自哪里」，可能过时，不当 base。
- **适配契约**：`skills/pstack/README.md` 的「包含什么」表，加 `.pi/plans/pi-kit/specs/2026-10-20-pstack-adoption-design.md` 的「适配替换表」与 Decisions。
- **门禁**：`scripts/pstack-skills.test.ts`。

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

其余 7 个 `SKILL.md` 用整文件 diff 起手，再读两边全文：

```bash
for s in blast-radius correct no-comments benchmark-checklist show-me-your-work technical-writing unslop interrogate swarm arena create-verification-skill maintain-verification-skill; do
  echo "== $s"
  diff -u "/tmp/pstack-upstream/harness/pstack/claude-code/skills/$s/SKILL.md" "skills/pstack/$s/SKILL.md"
done
```

整文件 diff 会带上已知适配，这是预期。只判断一件事：diff 里有没有**适配契约之外**的上游新规则。

`principles/SKILL.md` 没有上游对应物，是本地索引；它只在叶子增删时跟着改 bullet。

完成判据：每个文件都归入「只剩已知适配」或「有未知差异」。

## 3 没有未知差异就停

未知差异为 0：输出 `no material change: local matches <version> (<sha>)`，跑门禁（第 7 步），停。不要为了交差编一条升级。

## 4 分级

| 级别 | 判据 | 本组例子 |
|---|---|---|
| P0 | 适配契约被上游改写；原则 id 增删；新增/删除原则 | 上游删掉 `blast-radius` 的「证明那一个事实」；上游新增一条 `principle-*` |
| P1 | 正文规则变化，会改变行为 | `no-comments` 的 keep list 多一类或少一类注释 |
| P2 | 措辞收紧，行为不变 | 同一句改短；表格重排 |
| P3 | 链接、编码、格式 | principle 链接的写法变了 |

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

不搬：上游 Task 参数名、`pstack-models` 规则、上游 model slug、`AskUserQuestion`、`TodoWrite`、`.cursor` 路径、playbook 引用、Claude Code adapter 段、`poteto-mode`（本地入口是 `prompts/poteto.md`）。写委派改写成 `subagent` profile。

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

门禁必须全绿（当前 17 passed）。增删原则时，索引 bullet、`references/` 文件、测试里的 `24` 要一起改。

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

## 约束

- 不改 `disable-model-invocation`：除 `principles` 外都是 `true`。
- `name` 等于目录名；上游改名不跟。
- 不把 `principle-*` 拆成顶层 skill。
- 不改「`git remote -v` 决定 gh 还是 glab」这条判据。
- 上游新增 skill 只报告，不顺手导入：需要云隔离、worktree 并发写的先不进口；只读多模型评审按 P3 的 C′ 处理。
- 不为了对齐上游删本地适配；删一条要在报告里写理由。
