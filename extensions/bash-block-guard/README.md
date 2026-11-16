# bash-block-guard

拦住三类会让会话静默等待的 `bash` 调用。拦下时不执行命令，只把 reason 交回模型，reason 里给替代写法。

| 规则           | 触发                                                                                   | 为什么                                                |
| -------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `sleep-loop`   | 命令里有 `for` / `while` / `until`，且出现 `sleep`                                     | 轮询循环在等外部状态，整轮零输出                      |
| `sleep`        | `sleep N`，N ≥ 20                                                                      | 不产出进度，只占住这一轮                              |
| `long-timeout` | 工具参数 `timeout` > 300 秒                                                            | pi 会被要求静默等几分钟                               |
| `tail-follow`  | 命令里有 `tail -f` / `-F`（含 `-n 40 -f`、`-20f`），且那一段的 stdout 没有重定向到文件 | 跟随模式永不自己退出；`grep -m1` 只杀下游，上游照样活 |

放行：`sleep 5`、`sleep 10s`、引号里的 `sleep 30`、`#` 注释里的 `sleep`、`timeout` 200、heredoc 正文里的 `sleep`（`cat > poll.sh <<'EOF' … EOF` 只写文件不等待）、`tail -n 40 <log>`、`tail -f a.log > /tmp/b.log`（输出已入文件）。

`sleep` 的后缀按 GNU sleep 换算：`s`、`m`、`h`、`d`。`sleep 1m` 等于 60 秒，照样拦。

## `-c` 载荷递归

`sh -c "sleep 30"`、`bash -lc 'while ! grep -q x /tmp/a.log; do sleep 1; done'` 以前是放行的（引号在扫描前被剥掉，否则 `echo "sleep 30"` 会误拦）。现在先把 `-c` 的载荷取出来，再对载荷跑同一套判据（递归深度 3）：

| 命令                                              | 结果                          |
| ------------------------------------------------- | ----------------------------- |
| `sh -c "sleep 30"`                                | 拦（`sleep`）                 |
| `bash -c 'while ! grep -q x f; do sleep 1; done'` | 拦（`sleep-loop`）            |
| `bash -lc 'sleep 45'`                             | 拦（`sleep`，组合短选项也认） |
| `bash -c 'echo "sleep 30"'`                       | 放行（载荷里再剥一次引号）    |
| `bash -c 'tools/wait-log.sh /tmp/a.log ^PASS'`    | 放行                          |

只认 `-c`，不做通用 shell 解析：这是实际溜过去的形状（2026-11-15 两次 200s 的 while 循环），完整解析的边际收益抵不上误拦风险。

## 拦下来之后用什么

四段 reason 里都指向同一个替代品：

```shell
tools/wait-log.sh <log> <regex> [timeout=240] [interval=10] [--pid <pid>]
```

一次调用等到结论，每 `interval` 秒自己打一行进度（所以不撞 `sleep-loop`），命中 `exit 0`、超时 `exit 124`、被盯的进程先死 `exit 125`。pi-clients 里有一份（`tools/`，带自测）；**别的仓库没装也会读到这条提示，所以 reason 写的是「仓库里有就用它」**。

`tail-follow` 只看 stdout 重定向：`tail -f a.log 2>/dev/null` 仍然拦，因为进程照样不退出；`nsh test . > /tmp/a.log 2>&1 & timeout 200 tail -f /tmp/a.log | grep -m1 x` 也仍然拦——那个 `>` 属于前半段，不是 tail 这一段。

## 环境变量

| 变量                        | 默认  | 作用                                      |
| --------------------------- | ----- | ----------------------------------------- |
| `PI_BASH_GUARD_MAX_SECONDS` | `300` | `long-timeout` 的上限，合法长构建靠它放宽 |
| `PI_BASH_GUARD_DISABLED`    | 未设  | 设成 `1` 关闭本扩展的全部拦截             |

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
