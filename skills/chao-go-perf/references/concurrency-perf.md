# 并发性能详解

## 扩展性测试

```go
func BenchmarkConcurrent(b *testing.B) {
    for _, procs := range []int{1, 2, 4, 8, 16} {
        b.Run(fmt.Sprintf("GOMAXPROCS=%d", procs), func(b *testing.B) {
            b.SetParallelism(procs)
            b.RunParallel(func(pb *testing.PB) {
                for pb.Next() {
                    doWork()
                }
            })
        })
    }
}
```

## 常见瓶颈

| 瓶颈 | 症状 | 工具 |
|------|------|------|
| 锁竞争 | CPU 增加但吞吐不涨 | mutex profile |
| False sharing | 多核更慢 | 检查相邻热点字段 |
| 分配过多 | GC 压力升高 | allocs / heap profile |
| Channel 阻塞 | goroutine 长时间等待 | block profile |

## 锁选择

- 简单计数器：`atomic`
- 读写均衡：`sync.Mutex`
- 读多写少：`sync.RWMutex`
- 特殊缓存场景：`sync.Map`

## Channel vs Mutex

- Channel：传递所有权
- Mutex：保护共享状态

## 减少锁持有时间

把 I/O 和重计算移到锁外，只在读写共享状态时持锁。

## Goroutine 泄漏

常见来源：
- 无接收者的发送
- 没有退出条件的 select
- WaitGroup 计数不匹配

建议配合 `context.Context`、buffered channel 或 `go.uber.org/goleak` 检查。
