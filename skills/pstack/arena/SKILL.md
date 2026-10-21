---
name: arena
description: "同一个任务并行跑 N 个候选，选一个作基底，把落选者的强项嫁接进来。Use when 非平凡产物一次成型会锁死错误形状，或用户说 /arena、抛进竞技场、多方案对比。"
disable-model-invocation: true
---

# Arena

先建 todo，一项一个阶段：Frame / Fan out / Cross-judge / Pick / Graft / Verify。

## A. Frame

1. 写清每个候选要产出的东西。
2. 定 rubric：3 到 6 条可判定的标准。候选只看任务，不看 rubric。
3. 定候选数：默认 2 到 3 个，受 4 并发限制。
4. 每个候选一个独立输出位置：`/tmp/arena-<slug>/candidate-<n>/`。要改代码就产出 patch 文件，不要直接改同一工作树。

## B. Fan out

用 `subagent`，`agent: "general"`，`background: true`。

每个候选的 task 自包含：任务、共享背景的路径、自己的输出路径、要求产出产物加一段短 rationale（考虑过哪些替代、拒了什么）。

候选可以同模型。要模型多样性，就给不同 profile 配 `model:`，并在报告里写清每个候选用的模型。

候选没产出就按 N-1 继续，记 dropout。

## C. Cross-judge

候选都完成后，用 `subagent` 的 `reviewer` 做一次只读打分。给它 rubric 与按路径标注的候选，逐条打分并推荐基底。有多模型 profile 就换一个模型。不要与候选同时跑。

## D. Pick

读完每个候选再选。按 rubric 逐条打分，不看整体感觉，再和 judge 对比。一致就确认；不一致就读两边理由再定。选未来维护者最容易扩展、边界最清楚的那个。

## E. Graft

把落选者里值得搬的一两点手工折进基底，通常每个候选一两点。不要机械粘贴。

候选收敛到同一形状就记下来，直接采用，不嫁接。分歧过大说明 A 阶段没写清，重写再跑，不要平均。

## F. Verify

按 `/skill:principles prove-it-works` 验合成产物。验证发现问题，要么 A 阶段错了，要么漏了某个候选的强项，回去改，不要糊过去。

## Outputs

一个合成产物，加一段合成说明：基底与理由、cross-judge 的结论、每个 graft 来自哪个候选、拒了什么及原因、收敛或 dropout、验证结果。

## 边界

- 候选不直接改同一工作树。
- 不自动合并，不把 judge 的推荐当最终决定。
- 不平均分歧；分歧大就重写任务。
