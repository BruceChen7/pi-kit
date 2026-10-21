---
name: interrogate
description: "对一份改动做独立的对抗评审：一个 reviewer 一份，父会话合并 findings 并给出裁定。Use when 用户说 interrogate / adversarial review / 多模型评审 / 压力测试这份代码 / 找盲点，或收尾前对高风险 diff 要第二意见。"
disable-model-invocation: true
---

# Interrogate

让独立的 reviewer 从不同角度审同一份改动，父会话出合并裁定。对抗信号来自独立性，不是角色扮演。只报告，不改码。

默认中文。

## 一、范围

从上下文取要审的东西：

- 用户点名了文件或 diff，就用它。
- 在 feature 分支上，用当前分支相对 base 的 diff。base 默认 `origin/HEAD`，取不到就 `main` 或 `master`。
- 用户提到最近的工作，就把相关文件收进来。

连同理解这段代码需要的周边文件一起打包。

## 二、意图

派 reviewer 之前，先用一段话写清这次改动想做什么。来源是用户的话、commit message、PR/MR 描述和代码本身。意图说不清就先问，不要带着猜测开审。

## 三、派 reviewer

用 `subagent` 工具，每个 reviewer 一次 run：

- `agent: "reviewer"`（只读，不能改文件）
- `background: true`
- `task`: 下面四样拼在一起，必须自包含，子会话看不到本对话。

先把三份模板读出来：`references/reviewer-prompt.md`、`references/rubric.md`、`references/code-quality-review.md`。每个 reviewer 的 task 都填同一份模板，替换成这次的范围与意图。

几个 reviewer：

- 默认 2 个。
- 想要模型多样性：在 `.pi/agents/` 建 `reviewer-a.md`、`reviewer-b.md`，各自写 `model: <provider/model>` 和 `thinking`；用 `subagent doctor` 确认 profile 被识别。
- 没有自定义 profile：用默认 `reviewer` 跑 2 份，并在报告里写「同模型」。
- 最多 4 个并发；超过 4 个分批，不要一次派完。

如果某个 run 失败，记下 runId 与错误，换一份重派一次；第二次失败就在报告里记 gap，不要跳过。

## 四、合并

结果回来后先合并：

- 描述同一问题的 findings 合成一条，记下哪些模型分别提过。
- 两个及以上模型独立提到的是最高信号。
- 只有一个模型提到的也读，但按信号强度降权。
- 模型之间明确冲突的，写进裁定，不要抹平。

## 五、裁定

你是 lead reviewer，不是中性聚合器。读 `references/lead-judgment.md`，把每条 finding 放进四个桶之一，带模型名和一行理由。

- **Act on**：影响正确性、安全或可维护性，放在真实 PR 里会挡住的。
- **Consider**：成立，但现在修的收益与成本不确定，值得用户看。
- **Noted**：技术上成立但当前不可行动，或只是过早优化。
- **Dismissed**：错的、挑刺的、缺上下文的，写一句原因。

没有 `file:line` 的 finding 不能进 Act on / Consider。

## 输出格式

### 意图
> 第二步写的那段话。

### Reviewers
- Reviewer A：模型名，N 条 findings
- Reviewer B：模型名，N 条 findings

### Act on
每条：问题、哪些模型提到、为什么重要。

### Consider
每条：问题、哪些模型提到、取舍。

### Noted
简短列表。

### Dismissed
每条一句原因。

### Agreement Map
模型在哪里一致、在哪里分歧，这个分布说明什么。

## 边界

- 不自动改码，不改工作树。
- 不把「同模型多跑几份」说成多模型评审。
- 不因为模型多就堆 findings；只留能指出位置和后果的。
