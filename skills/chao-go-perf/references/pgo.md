# PGO — Profile-Guided Optimization

## 什么是 PGO

PGO 会把代表性 profile 反馈给编译器，帮助它做更好的内联与代码布局决策。

## 基本流程

```bash
curl -o default.pgo http://localhost:6060/debug/pprof/profile?seconds=30
go build -o app
```

把 `default.pgo` 放在 `main` 包目录后，`go build` 会自动启用。

## 验证方式

```bash
rm -f default.pgo
go build -o app-no-pgo
go test -bench=. -count=10 > no-pgo.txt

go build -o app-pgo
go test -bench=. -count=10 > pgo.txt

benchstat no-pgo.txt pgo.txt
```

## 注意事项

- profile 必须代表真实负载
- 常见收益是 2-7%
- 不是银弹，通常作为已有优化后的额外加成
