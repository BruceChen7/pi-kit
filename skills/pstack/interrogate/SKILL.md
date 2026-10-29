---
name: interrogate
description: "对一份改动或设计做独立的对抗评审：对抗者必须用一次 run 证伪每条 finding，父会话复现后才留下。Use when 用户说 interrogate / adversarial review / 多模型评审 / 压力测试这份代码 / 找盲点，或收尾前对高风险 diff 要第二意见。"
disable-model-invocation: true
---

# Interrogate

对抗者试着把一份改动或一个设计打坏。一条 finding 只有在一次 run 证明它之后才算数。只报告，不改码。

默认中文。命令、输出、`file:line` 原样保留。

## 一、范围与意图

范围是用户点名的那块。没点名就是当前分支相对 base 的分支 diff，一直算上工作树里未提交的改动。base 默认 `origin/HEAD`，取不到就 `main` 或 `master`。

再用一段话复述这次改动想做什么，来源是用户的话、commit message、PR/MR 描述和代码本身。说不清就先问，不要带着猜测开审。

## 二、派对抗者

按 `/skill:arena` 的 A 阶段第 3、4 步与 B 阶段跑 fan-out，四处改动：

- 候选数按对抗者算：默认 2 个，最多 4 并发。
- 每个对抗者一个 `/tmp/interrogate-<slug>/adversary-<n>/`，把范围里未提交的改动复制进去。
- `subagent`，`agent: "general"`，`background: true`。要有 bash 和写权限才跑得动 repro，隔离靠自己的目录，不靠只读。
- task 里不放 arena 的候选任务与 rationale，放范围、意图和下面这段 brief：

> 把这次改动打坏。每条 finding 都用一次真实代码上的 run 证明：失败的测试、repro 脚本，或者显示错误行为的命令输出。设计或计划就搭个原型，或者在当前工作树里探。repro 只写在自己的目录里。每条 finding 报标题、确切命令、命令打印的输出，以及意图要求的输出。没跑过的不要写。风格、命名、结构，以及要等将来改动才会咬人的风险，都不用报。找不到问题是正常结果。

对抗者看不到本对话，task 必须自包含。范围里未提交的改动只在对抗者自己的副本上动，仓库工作树不动。

如果某个 run 失败，记下 runId 与错误，照同一份 task 重派一次；第二次失败就在报告里记 gap，不要跳过。

## 三、复现后才裁定

逐条复现：按 finding 里的命令重跑一次。输出确实显示失败，而且这个失败确实破坏意图，才留下；其余丢掉。同一个根因的合并成一条。

跳过 arena 的 C、D、E 阶段：不做 cross-judge，不挑一个基底，不嫁接。对抗者找的是不同的失败，所以裁定保留每条被复现的 finding，不是某一个对抗者的清单。

## 输出

- **意图**：复述的那段话。
- **Findings**：每条被复现的 finding 给命令、它的输出、它怎么破坏意图，以及哪些对抗者报过它。一条都没留下就写「没有复现成功的 finding」。
- **Dropped**：每个对抗者丢掉几条、为什么。

## 边界

- 只报告，不改码，不动工作树。
- 没有命令与输出的 finding 不进 Findings。
- 不把「同模型多跑几份」说成多模型评审。
- 不因为对抗者多就堆 findings；同一根因合并成一条。
