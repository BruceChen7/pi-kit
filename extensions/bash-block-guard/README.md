# bash-block-guard

拦住三类会让会话静默等待的 `bash` 调用。拦下时不执行命令，只把 reason 交回模型，reason 里给替代写法。

| 规则 | 触发 | 为什么 |
| --- | --- | --- |
| `sleep-loop` | 命令里有 `for` / `while` / `until`，且出现 `sleep` | 轮询循环在等外部状态，整轮零输出 |
| `sleep` | `sleep N`，N ≥ 20 | 不产出进度，只占住这一轮 |
| `long-timeout` | 工具参数 `timeout` > 300 秒 | pi 会被要求静默等几分钟 |

放行：`sleep 5`、`sleep 10s`、引号里的 `sleep 30`、`#` 注释里的 `sleep`、`timeout` 200、heredoc 正文里的 `sleep`（`cat > poll.sh <<'EOF' … EOF` 只写文件不等待）。

`sleep` 的后缀按 GNU sleep 换算：`s`、`m`、`h`、`d`。`sleep 1m` 等于 60 秒，照样拦。

## 已知盲区

把等待藏进引号字符串的调用会放行，例如 `sh -c "sleep 30"`。扫描前会剥掉引号内容，否则 `echo "sleep 30"` 会被误拦；两者取舍后选了不误拦。这条盲区有测试固定住（`accepts the documented blind spot of a wait inside sh -c`），不是意外。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PI_BASH_GUARD_MAX_SECONDS` | `300` | `long-timeout` 的上限，合法长构建靠它放宽 |
| `PI_BASH_GUARD_DISABLED` | 未设 | 设成 `1` 关闭本扩展的全部拦截 |

## 为什么是拦截而不是改写

把 `for` 循环自动改成一次查询需要理解这条命令想检查什么，改错会静默丢掉检查。拦下来由模型决定换成哪条命令，人类也能看见这次拒绝。

先例：2026-10-29 两个会话里，用户两次说「卡死了」，前后是 `seq 1 50` × `sleep 20` 的 CI 轮询（`timeout` 1100）和一条 `timeout 300` 加 `tail -3` 的安装命令，整场显式 sleep 约 5400 秒。

## 启用

```shell
ln -s ../../extensions/bash-block-guard .pi/extensions/bash-block-guard
```

装完重启 pi 会话生效。

## 验证

```shell
npx vitest run extensions/bash-block-guard
npx tsc --noEmit
npx biome check extensions/bash-block-guard/
```
