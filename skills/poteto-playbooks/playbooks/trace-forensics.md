---
name: trace-forensics
description: 离线产物诊断的步骤清单。已抓到的 profile 或 heap snapshot 怎么读成诊断。Use when 手上已有 cpuprofile、trace、spindump、heapsnapshot。
---

# Trace forensics

**你拥有从产物出的诊断。**

与 runtime forensics 不同，那边给活进程打点。这里抓取已经存在，产物是固定数据集，读它，不要重跑。工具保持通用。cpuprofile 与 `.json.gz` 用 trace 解析器，spindump 用文本编辑器，heapsnapshot 用堆工具。

1. 认格式，用对工具载入。大产物放 `subagent explore` 解析（`principles: guard-the-context-window`），主线程留缩减后的结论。
2. 把原始产物变成可查的形状。把 trace 或 heap snapshot 灌进 sqlite，一行一个样本、帧或节点。先到可查形状再开始读。
3. 收窄到原因。查占时间最多的帧，沿调用树走到热路径。泄漏就跟持有链到 GC root。spindump 就找卡在 CPU 上或阻塞的线程及其等待原因。
4. 归因到源码。用产物自带符号把热帧映射到文件、符号、行。没有源码映射的帧还不算诊断，解析符号，或者直接说产物没带。
5. 有成对抓取就 diff 前后产物确认。没有就把结论标为产物支持的最强假设，不是确认的因果。
6. 交回带引用的诊断，没被要求就不修。原因清楚后转 Bug fix 或 Perf issue。throughput checkpoint 只留一行，`n/a, read-only forensics`。

**回复：** 产物与格式，缩减后的结论，源码位置，产物路径，成对抓取是否确认了它。
