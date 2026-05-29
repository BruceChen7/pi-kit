---
name: chao-go-perf
description: >
  Go 性能分析专家。用于分析 CPU/内存性能瓶颈、benchmark 设计、pprof、逃逸分析、GC
  调优、编译器优化（BCE/内联）、CPU cache/false sharing、并发性能、PGO 与 Go
  版本性能差异。用户提到 Go 性能、benchmark、benchstat、profile、pprof、内存分配、逃逸、
  sync.Pool、cache line、false sharing、GC 优化、编译器优化、BCE、bounds check、内联、
  profile-guided optimization、字符串拼接性能、slice 预分配、struct 布局优化等话题时应使用此 skill。
version: 1.0.0
---

# Go 性能分析专家

这是一个 vendored 到 Pi Kit 仓库中的本地 skill，目录位于 `skills/chao-go-perf/`。
当用户的问题涉及 Go 性能诊断、benchmark 设计、热点定位或微观优化取舍时，优先使用本 skill。

权威知识来源：

- [Dave Cheney's High Performance Go Workshop (GopherCon 2019)](https://dave.cheney.net/high-performance-go-workshop/gophercon-2019.html)
- [dgryski/go-perfbook (中文版)](https://github.com/dgryski/go-perfbook/blob/master/performance-zh.md)
- [Effective Go](https://go.dev/doc/effective_go)
- [Go Optimizations 101 (go101.org)](https://go101.org/optimizations/101.html)

## Use When

当用户遇到以下情况时使用：

- 需要分析 Go 程序为什么慢、为什么分配多、为什么 GC 压力大
- 需要审查 Go 代码中的性能反模式并给出优化建议
- 需要写或修 benchmark、解释 `benchstat` 输出、判断优化是否真实有效
- 需要分析 `pprof` / `trace` / `fieldalignment` / `-gcflags="-m"` / `GOSSAFUNC` 等工具输出
- 需要判断 `sync.Mutex` / `sync.RWMutex` / `atomic` / `sync.Map` / channel 的性能取舍
- 需要讨论 BCE、内联、逃逸分析、false sharing、预分配、对象复用、PGO、Go 版本升级收益

## 工作原则

1. 先测量，再优化。
2. 用 benchmark 和 benchstat 证明优化有效。
3. 优先关注分配、热点路径与并发瓶颈。
4. 说明优化原理、验证方法和适用边界。
5. 不鼓励凭直觉做“玄学优化”。

## 标准输出

回答 Go 性能问题时，尽量按这个结构组织：

1. **问题分类**：CPU / 分配 / GC / 并发 / 编译器 / cache
2. **证据或建议的观测方式**：benchmark、pprof、trace、逃逸分析、编译器 flag
3. **优化假设**：为什么这一改动可能有效
4. **建议改动**：优先最小、最可验证的改动
5. **验证方法**：`go test -bench`、`benchstat`、`pprof`、`-gcflags`、`-race`
6. **风险与边界**：可读性、生命周期、并发语义、内存占用、版本差异

## 快速诊断命令

```bash
go test -bench=. -benchmem -memprofile=mem.out
go tool pprof -top -alloc_space mem.out

go test -bench=. -cpuprofile=cpu.out
go tool pprof -top cpu.out

go build -gcflags="-m" ./... 2>&1 | grep "escapes to heap"
go build -gcflags="-m -m" ./... 2>&1 | grep "inlin"
go build -gcflags="-d=ssa/check_bce" ./...
fieldalignment ./...
go test -race ./...
GODEBUG=gctrace=1 ./app
```

## 参考文件

需要更详细信息时再加载对应文件：

- `references/benchmarking.md` — 基准测试编写、benchstat 详解、常见反模式
- `references/memory-optimization.md` — 逃逸分析详解、分配减少策略、Pool 最佳实践
- `references/cpu-optimization.md` — BCE、内联、编译器 flag、汇编分析
- `references/cache-optimization.md` — CPU 缓存、false sharing、struct 布局
- `references/concurrency-perf.md` — 锁选择、分片、channel vs mutex、竞争分析
- `references/tooling.md` — pprof、trace、fieldalignment、benchstat 完整用法
- `references/version-changes.md` — Go 版本间关键性能变更详情
- `references/pgo.md` — Profile-Guided Optimization 完整工作流
