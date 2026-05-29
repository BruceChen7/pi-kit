# Benchmark 方法论

## 正确编写 Benchmark

### 基本结构

```go
var sink int

func BenchmarkFib(b *testing.B) {
    var r int
    for i := 0; i < b.N; i++ {
        r = fib(20)
    }
    sink = r
}
```

要点：
- 用 sink 变量阻止编译器消除被测代码
- 用 `b.ResetTimer()` 排除 setup 时间
- 用 `-benchmem` 同时看 `allocs/op` 与 `B/op`
- 用 `-count=10` 降低噪声

## benchstat

```bash
go install golang.org/x/perf/cmd/benchstat@latest
go test -bench=. -count=10 > old.txt
go test -bench=. -count=10 > new.txt
benchstat old.txt new.txt
```

### 输出解读

- `p < 0.05`：差异更可能真实有效
- `± X%`：波动范围
- `delta`：优化前后差异

## 常见反模式

| 反模式 | 后果 | 正确做法 |
|--------|------|---------|
| 无 sink 变量 | 代码被消除 | 用 `var sink T` |
| setup 放在循环内 | 测到了准备时间 | 用 `b.ResetTimer()` |
| count=1 | 结果不稳 | 用 `-count=10` |
| 不看 allocs/op | 漏掉内存问题 | 加 `-benchmem` |
| 不用 benchstat | 把噪声看成优化 | 用 benchstat |

## 表驱动 Benchmark

```go
func BenchmarkProcess(b *testing.B) {
    for _, n := range []int{10, 1000, 100000} {
        b.Run(fmt.Sprintf("n=%d", n), func(b *testing.B) {
            data := generateData(n)
            b.ResetTimer()
            for i := 0; i < b.N; i++ {
                process(data)
            }
        })
    }
}
```
