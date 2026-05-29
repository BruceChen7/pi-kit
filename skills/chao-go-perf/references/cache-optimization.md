# CPU 缓存与内存布局优化

## Cache Line 基础

- cache line 通常为 64 字节
- 连续访问通常比随机访问更 cache-friendly
- 多核写同一 cache line 上的不同字段会触发 false sharing

## False Sharing

```go
type Counters struct {
    a int64
    b int64
}
```

可通过 padding 隔离热点字段：

```go
type PaddedInt64 struct {
    value int64
    _     [56]byte
}
```

## Struct 布局优化

按字段大小从大到小排，减少 padding：

```go
type Bad struct {
    a bool
    b int64
    c bool
}

type Good struct {
    b int64
    a bool
    c bool
}
```

检查工具：

```bash
go install golang.org/x/tools/go/analysis/passes/fieldalignment/cmd/fieldalignment@latest
fieldalignment ./...
```

## 数据局部性

- 高频遍历优先 `slice/array`
- 只访问部分字段时，SoA 常优于 AoS
- 链表通常不如连续数组 cache-friendly

## 分支预测

随机分支会拖慢热循环；让数据更有序、分支更可预测，通常更快。
