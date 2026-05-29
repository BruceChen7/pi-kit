# CPU 优化详解

## BCE — 边界检查消除

```bash
go build -gcflags="-d=ssa/check_bce" .
```

无输出通常表示检查已被消除；看到 `Found IsInBounds` 往往表示检查仍保留。

### 容易 BCE 的写法

```go
for i := 0; i < len(s); i++ {
    total += s[i]
}

for _, v := range s {
    total += v
}
```

## 内联

```bash
go build -gcflags="-m -m" . 2>&1 | grep -E "inlin(e|ing)"
```

小函数更容易被内联；大流程函数通常不会。

## 编译器 flag

```bash
-gcflags="-m"
-gcflags="-m -m"
-gcflags="-d=ssa/check_bce"
-gcflags="-l -N"
go tool compile -S main.go
GOSSAFUNC=myFunc go build .
```

## 经验法则

- 先看 profile，再考虑微优化
- 优先让循环和数据访问模式更简单
- 不要为了“手动内联”牺牲太多可读性，除非 profile 证明值得
