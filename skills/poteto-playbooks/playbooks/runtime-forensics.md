---
name: runtime-forensics
description: 活体诊断的步骤清单。给运行中的进程打点取证，交付带引用的诊断，不交付修法。Use when 症状是泄漏、空转、视觉抖动这类运行时表现。
---

# Runtime forensics

**你拥有诊断。给活进程打点，不要从源码推演。** 交付物是带引用的诊断，不是修法。

1. 在匹配立面上抓活信号。空转进程抓 CPU profile，泄漏抓 heap snapshot，视觉抖动抓 CDP trace。要真实产物，不要猜。
2. 把产物缩到冒烟枪。热路径上的函数，泄漏对象到 GC root 的持有链，没有输入却触发的循环。大产物放 `subagent explore` 解析（`principles: guard-the-context-window`），主线程只留缩减后的结论。
3. 相信机制之前先证明机制。用 CDP eval 给运行中进程注入打点，或热修活代码而不重载，用最小代价确认假设。
4. 把结论映射回源码。文件、符号、分配或调度的那一行。
5. throughput checkpoint 只留一行，`throughput checkpoint: n/a, read-only forensics`。

**回复：** 抓到什么信号，缩减后的结论，怎么证明的机制，源码位置，产物路径。没被要求就不修。原因清楚后交回 Bug fix 或 Perf issue。
