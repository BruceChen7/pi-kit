---
description: 把这次对话里某个话题的那一段，变成 Jira 子任务 + 按单号建分支 + 改码 + 提交 + push
argument-hint: "<topic> [--parent <KEY>] [--reuse <KEY>] [--dry-run]"
---

把**这次对话**里围绕 `<topic>` 的那一段，落成一条交付链：

```
这段对话 → Jira 子任务 → 按单号建分支 → 改码 → 提交 → push → 回写单描述
```

范围只取当前对话。不读历史会话文件，不生成中间文件，不写提取脚本。总结由你做。

默认中文写单，默认英文写 commit message。

## 参数

- `<topic>` 必填，位置参数。多个词用逗号分隔，也可以直接写边界，例如
  `去掉放量开关` / `hooksPath 被覆盖,从我发现它开始` / `只看最近讨论的单元测试改动`。
- `--parent <KEY>` 新建单时必填。**没给就停下来问用户要哪个父单**，不要从别的单猜。
- `--reuse <KEY>` 不建单，直接用这个单号往下走。
- `--dry-run` 停在 Step 2 之后，只打印选中的轮次与拟建的单，不写 Jira、不动 git。

## Step 1 圈范围

在当前对话里找出 `<topic>` 覆盖的那几轮：用户发言、你的结论、实际跑过的命令与它们的输出。

先把选中的**锚点**列给用户，一条一句话，标出它在对话里的位置（第几轮 / 哪条消息）：

```
选中的轮次（共 4 段）：
1. 用户提出「开关已全量，想删干净」 — 第 3 轮
2. 查到 5 个 toggle 的实际放量值 — 第 6-8 轮，含 CC 读数
3. 删码后 build/vet/lint 结果 — 第 12 轮
4. 遗留的 2 个 CC key 与清理顺序 — 第 14 轮
```

范围跑偏时用户一句话就能改。**等用户点头再往下走。**

用户在 `<topic>` 里给了边界就按他的边界，不要扩。找不到可交付的改动（纯问答、只是查了个状态）就停在这里说明，不建单。

## Step 2 归纳 WorkItem

把选中的内容压成五个字段。每个字段只能来自对话里已经查实的东西；没查实的写「未验证」，不编。

| 字段 | 内容 | 落到 Jira |
| --- | --- | --- |
| `problem` | 要解决什么，现在错在哪 | `h3. 问题` |
| `code_location` | `file:line` + 符号名，至少一条 | `h3. 代码位置` |
| `repro` | 最小复现命令或步骤 | `h3. 复现` |
| `change_scope` | 要改哪些文件/模块，不做什么 | `h3. 改动内容` |
| `acceptance` | 怎么算完成，跑什么命令 | `h3. 验证` |

`summary` 用父单下已有子任务的命名风格，通常是 `【BE】<一句话中文>`，不加空格。

## Step 3 建单

### 3.1 先查字段形状

字段形状从**当前父 task 下你自己的子任务**取，不从别的单回推。先从 `git config user.email` 拿自己的账号，不要把它写死在模板里。

```js
// ① 列父单下的子任务，按创建时间倒序，再按 assignee 过滤出自己的
const me = (await tools.bash({ command: "git config user.email" })).trim();
const r = await tools.mcp__toolverse_1787657608__search_jira_ticket({
  jql: "parent = <PARENT> ORDER BY created DESC", limit: 50 });
const mine = (r.structuredContent?.issues ?? []).filter(
  it => JSON.stringify(it.fields?.assignee ?? {}).includes(me.split("@")[0]));

// ② 取最近 1 至 2 条，读 fields 与 _field_names，看要填哪些字段、取值什么形状
const t = await tools.mcp__toolverse_1787657608__get_jira_ticket({ issue_key: mine[0].key });
const f = t.structuredContent?.issue?.fields ?? {};
const names = t.structuredContent?.issue?._field_names ?? {};
```

产出一张对照表：要填的字段、从哪条子任务抄的值。抄不到的字段不填。

两条硬约束：

- **不要调 `get_create_jira_meta`**。它返回 16MB 被网关拒掉（`MCP SSE event exceeds 16777216 bytes`），必失败。
- **codemode 里用 `r.structuredContent`，不要 `JSON.parse(r)`**。工具返回的是对象，`JSON.parse` 会报 `SyntaxError: unexpected token: 'object'`。

`parent` 字段没给就现在问用户，不要推测。

### 3.2 打印再写

先把完整建单参数打给用户：`project` / `parent` / `issuetype` / `summary` / `description` 全文，以及从子任务抄来的那些字段。

`--dry-run` 到这里结束。

**等用户确认**，再调 `create_jira_ticket`。建单会通知人，不可撤。

拿到 `issue_key` 后立刻读回来核对：`parent`、`issuetype`、`summary`、描述长度。

## Step 4 建分支

`<KEY>` 是整条链唯一身份。分支名按仓库的 git 规范拼：

```
<email-prefix>/<type>/<KEY>/<slug>
```

- `email-prefix` 从 `git config user.email` 取 `@` 前面那段。
- `type` 取 `feature|hotfix|bugfix|doc|tech`，跟这次改动的性质一致。
- `slug` 全小写、`-` 分隔、不加下划线。

动手之前先报给用户，一起给 `git log -1 --oneline` 当起点：

```
拟建分支：ming.chen/bugfix/SPV-52370/respect-existing-hookspath
起点：    e577118 Merge branch 'sen.xie/feature/SPV-52081/...' into 'master'
```

**等用户确认**，再执行：

```bash
KEY=<KEY>; b=<拟建分支>
git fetch origin
git branch -a --list "*$KEY*"     # 已有同名分支先问要不要切过去，别重复建
[[ "$b" =~ ^[A-Za-z0-9._-]+/(feature|hotfix|bugfix|doc|tech)/[A-Za-z]+-[0-9]+/[A-Za-z0-9_-]+$ ]] \
  && echo "PASS $b" || echo "FAIL $b"
git switch -c "$b"
```

正则不过就改名字重报，不要硬建。分支名过不了 pre-push，push 时才炸。

slug 优先用 `-`。pre-push 放行 `_`，但仓库 git 规范禁止下划线，review 阶段会被挑出来。

## Step 5 改码

先 `route_task` 定路由（`feature` / `bugfix` / `refactor` / `perf`），按它给的 steps 和闸门走。

Step 2 的 `acceptance` 就是这次的完成条件。跑不到就说明哪条没过，不要写成「应该没问题」。

## Step 6 提交

走 `branch-commit-push` 的闸门（format + lint 必须过），commit message 带单号：

```
[<KEY>] <type>: <changes>
```

`<type>` 与分支名里的一致。一个 commit 只装一个目的；多个目的写正文列清。

## Step 7 push 与回写单

```bash
git push -u origin "$(git branch --show-current)"
```

push 完回到 Jira，把 `description` 改成实际发生的事：`h3. 改动内容` 按模块列、`h3. 验证` 贴真跑过的命令与输出、`h3. 备注` 放遗留项与回滚方式。描述里能对上的 commit hash 要写上。

最后回报四件事：单号与链接、分支名、commit 列表、跑过的验证命令。

## 硬约束

- 三个地方停下来等确认：圈完范围、建单前、建分支前。每个地方都想清楚给用户看什么、等什么、他否了怎么退。
- `--reuse` 时跳过 Step 3，但 Step 4 到 Step 7 一步不少。
- 报数字、报结论都带证据：跑过贴输出，推断说依据，猜就写「未验证」。
