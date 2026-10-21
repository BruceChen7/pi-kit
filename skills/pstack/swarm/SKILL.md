---
name: swarm
description: "把一份可切分的活分片派给多个 worker，收齐后出一份统一报告。Use for /swarm、覆盖矩阵、竞态、分片调查，或需要并行覆盖多个目录、用例、切片时。"
disable-model-invocation: true
---

# Swarm

先建 todo，一项一个阶段：Frame / Fan out / Aggregate / Report。

## A. Frame

1. 写清完成的判据，以及最后要交的产物或报告。
2. 选形状：分片、同题竞态，或混合。竞态先声明 `first pass`、`rank all` 或 `best-of`。
3. 按 `subagent` 的边界写任务：
   - 只读分片：`agent: "explore"`。
   - 写任务：`agent: "general"`，每个 worker 的输出必须落在不相交的目录或文件。默认 `/tmp/swarm-<slug>/slice-<n>/`。
   - 同一工作树并发写：不做。改成分片只读，或串行。
4. 波次：最多 4 个并发。N 大于 4 就分批，前一批收完再发下一批。
5. 每个 brief 自包含：目标、范围、分片、怎么验证、报告格式。验证 commit 时写清 SHA；测性能时写清方法与样本数。

## B. Fan out

用 `subagent`，每个 worker 一次 run，`background: true`。

报告只用 `PASS`、`ISSUES`、`BLOCKED`，每条带证据：路径、命令输出、SHA。能证明缺陷的 worker 报 `ISSUES`，并列出它能证明的每一条，不只第一条。

worker 掉线就按 N-1 继续，并记下来。

## C. Aggregate

读结果。缺 brief 要求的证据或 SHA 的，丢掉并重派一次；第二次还缺，记 gap，gap 不算 PASS。

覆盖要求每一片都有结果。竞态按事先声明的规则选。不要把 worker 的原始输出整段贴回来。

## D. Report

一份合并报告：结果表、问题一行一条、gap 或掉线、竞态规则（用了才写）。

## 边界

- 不改同一工作树的并发写。
- 不把 4 个以上 worker 一次派完。
- 不把没有证据的结果算作通过。
