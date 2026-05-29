# 内存优化详解

## 逃逸分析

```bash
go build -gcflags="-m" .
go build -gcflags="-m -m" . 2>&1 | grep "escapes to heap"
```

常见逃逸来源：
- 返回局部变量指针
- `interface{}` 装箱
- 闭包捕获
- 指针发到 channel
- 大对象或未知大小分配

## 减少分配

### slice 预分配

```go
s := make([]string, 0, len(data))
```

### map 预分配

```go
m := make(map[string]int, len(data))
```

### strings.Builder

```go
var b strings.Builder
b.Grow(estimatedSize)
```

### 少做 `[]byte` ↔ `string` 转换

热路径中尽量维持同一种表示，避免来回复制。

## sync.Pool

适合：高频、短生命周期、可复用的临时对象。

使用要点：
- `Get` 后先 `Reset`
- `Put` 后不要继续用
- 不要把 pool 当缓存

## GC 调优

```bash
GODEBUG=gctrace=1 ./app
GOGC=200 ./app
GOMEMLIMIT=4GiB ./app
```

优先顺序通常是：
1. 降低分配
2. 复用临时对象
3. 再考虑调 `GOGC` / `GOMEMLIMIT`
