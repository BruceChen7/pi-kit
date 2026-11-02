# 源码史（git + 仓库内）

本机没有这个源时（既没有 `git` 也没有 forge CLI）：**不要报「查无此项」**，在
`Sources Consulted` 里写成 `not available in this environment`，并说清缺什么。

## 这个源里有什么

- commit 历史（message、日期、作者、diff）
- PR 描述、评审评论、讨论串（`gh` 或 `glab`，按 `git remote -v` 选）
- 行内注释、`TODO` / `FIXME` / 弃用说明
- ADR（如果仓库有）
- 测试：测试名与断言常编码了当初要解决的边界情况
- 同一 commit 里一起改的文件（共变信号）
- CHANGELOG 与 release notes
- commit message 与 PR 正文里的工单号

这是最可信、与代码绑定最直接、也最完整的源。走过仓库的东西都应该在这里。

## 怎么搜

从锚点种子扩开：

```bash
git log --follow --oneline -- <file>            # 跟过改名的历史
git log -S '<代码里的确切字符串>' -- <file>       # pickaxe：加了或删了这段文本的 commit
git log -G '<正则>' -- <file>                    # 按模式找
git blame -L <start>,<end> <file>                # 每一行是谁什么时候写的
git show <hash>                                  # 单个 commit 的完整 diff
git log <old>..<new> -p -- <file>                # 两点之间碰过这个文件的 commit
```

PR 与讨论：

```bash
gh pr view <n> --comments                        # 或 glab mr view <n> --comments
git log -1 --format=%B <commit>                  # 从 commit message 取 PR 号
```

仓库内的旁证：

```bash
rg -l -i 'architecture.decision' --glob '*.md'          # ADR 常在 docs/adr/ 之类
rg -n -C2 '(TODO|FIXME|HACK|XXX|NOTE)' <目标文件>        # 目标附近的 TODO
rg -l '<符号>' --glob '*test*'                            # 相关测试
```

## 好证据长什么样

- PR 描述里有一段「为什么」明确对上目标代码的用途
- 评审评论里作者解释了某个取值或做法（「评审时说这个是为了……」）
- 一个 commit 的 message 直接说明动机，例如「加防御检查，因为线上 X 反复触发」
- 测试用例的命名或断言编码了当初的边界条件
- 前后相继的 commit 显示一次「试了 A，回滚，换成 B」的过程

## 常见坑

- **近因偏差。** 最近一次改动不一定最权威。现在的形状常是许多更早决定的堆积。
- **只读 commit message，不读 diff。** message 可能是空的或套话。diff 才是改了什么。
- **只看单体 commit。** 相关改动常被拆成多个 commit 或跨多个 PR。
- **把共变当因果。** 同一 commit 里改了别的文件，不说明它们有动机关联。
- **改名后历史断了。** 忘了 `--follow` 会把历史截断在改名那一刻。

## 要返回什么

每个相关条目：

- 类型（commit / PR / 评审评论 / 注释 / ADR / 测试 / CHANGELOG）
- 标识（hash、PR 号、`file:line`、URL）
- 作者与日期
- 与问题相关的原文（尽量逐字）
- 相关性：它对目标代码暗示什么，连接有多强
