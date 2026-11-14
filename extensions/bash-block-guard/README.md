# bash-block-guard

拦住三类会让会话静默等待的 `bash` 调用。拦下时不执行命令，只把 reason 交回模型，reason 里给替代写法。

| 规则                           | 触发                                                                                   | 为什么                                                |
| ------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `sleep-loop`                   | 命令里有 `for` / `while` / `until`，且出现 `sleep`                                     | 轮询循环在等外部状态，整轮零输出                      |
| `sleep`                        | `sleep N`，N ≥ 20                                                                      | 不产出进度，只占住这一轮                              |
| `long-timeout`                 | 工具参数 `timeout` > 300 秒                                                            | pi 会被要求静默等几分钟                               |
| `tail-follow`                  | 命令里有 `tail -f` / `-F`（含 `-n 40 -f`、`-20f`），且那一段的 stdout 没有重定向到文件 | 跟随模式永不自己退出；`grep -m1` 只杀下游，上游照样活 |
| `unresolved-dynamic-execution` | 命令名由变量拼出来（`$RUNNER …`），或 `sh -c "$SCRIPT"` 的脚本是变量                   | 护栏看不进去就不放行                                  |
| `unparseable`                  | 引号没闭合等解析错误                                                                   | 看不进去的部分不能假装看懂                            |

放行：`sleep 5`、`sleep 10s`、引号里的 `sleep 30`、`#` 注释里的 `sleep`、`timeout` 200、heredoc 正文里的 `sleep`（`cat > poll.sh <<'EOF' … EOF` 只写文件不等待）、`tail -n 40 <log>`、`tail -f a.log > /tmp/b.log`（输出已入文件）。

`sleep` 的后缀按 GNU sleep 换算：`s`、`m`、`h`、`d`。`sleep 1m` 等于 60 秒，照样拦。

## 引号与嵌套脚本

扫描前先剥掉引号内容，否则 `echo "sleep 30"` 会被误拦。这曾经留下一个盲区：`sh -c "sleep 30"` 因为整段在引号里而被放行。

现在由共享的 shell 结构层（`extensions/shared/shell/`）补上：`sh -c` / `bash -c` / `eval` 后面是**字面量**脚本时，把它当嵌套命令递归判，所以 `sh -c "sleep 30"`、`bash -c "tail -f /tmp/x.log"` 都会被拦下。

脚本本身是变量（`sh -c "$SCRIPT"`），或命令名由变量拼出来（`$RUNNER --wait`）时，护栏看不进去 —— 这种情况 **fail-closed**：拦下并报 `unresolved-dynamic-execution`，reason 里请模型改写成字面量。刻意选这条而不是静默放行，因为"看不进去"恰恰是这类命令最需要被看见的地方。

heredoc 正文仍然不算命令：`cat > /tmp/poll.sh <<'EOF'` 后面写什么都只是文本，包括里面出现 `sh -c "sleep 30"`。

## 判定看的是结构，不是原文

规则不跑在命令原文上，而是查共享 shell 结构层给出的命令段与重定向（`extensions/shared/shell/`）：
- `sleep` 只看"有效命令名是 `sleep`"的那些段，参数里能否解析出时长；
- `sleep-loop` 只看结构关键字里有没有 `for` / `while` / `until`；
- `tail-follow` 只看 `tail` 那一段有没有 `-f`/`-F` 标志，以及它的 stdout 有没有落到文件（`2>/dev/null` 不算）。

这样 `echo "sleep 30"` 天然不会被误读（引号里不是命令段），也不需要再把原文正则化地"剥引号再扫一遍"。

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
