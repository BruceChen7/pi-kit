# bash-block-guard

拦住会让会话静默等待的 `bash` 调用。拦下时不执行命令，只把 reason 交回模型，reason 给可执行的替代路径。

判据来自 `unbash@4.0.12` 产出的 shell AST（`extensions/shared/shell-ast.ts`），不再对命令文本跑正则：循环、pipeline、`&&`、`$(...)` 替换都按结构遍历；heredoc 正文仍是数据，不会被当成命令。

包装器按 argv 结构逐层展开，不重新拼回 shell 源码：

- `sh/bash/zsh/dash/ksh -c '<script>'` 与 `eval '<script>'`：解析载荷；`eval` 参数是动态的则 fail-closed。
- 透明透传：`sudo`、`env`、`nice`、`nohup`、`strace`、`xargs`、`timeout`、`gtimeout`、`command`、`exec`、`builtin`、`time`（按各自的「吃值 flag」跳过，例如 `sudo -u root`、`timeout 5`、`nice -n 5`、`xargs -0`）。
- `-exec` 系：`find -exec/-execdir/-ok/-okdir`、`fd -x/--exec/-X/--exec-batch`，取 terminator 之前的 argv。

展开后的普通命令保留 token 边界，直接作为 AST 节点检查；无法静态判定的结构走 `unparseable` _fail closed_。

| 规则           | 触发                                                                                                               | 为什么                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `sleep-loop`   | 循环里的 `sleep`：单次 ≥ 20 秒，或循环体没有可见输出且总等待 ≥ 20 秒（无限循环按无界处理）                         | 轮询在等外部状态却零输出                              |
| `sleep`        | 非循环里的 `sleep N`，N ≥ 20                                                                                        | 不产出进度，只占住这一轮                              |
| `long-timeout` | 工具参数 `timeout` > 300 秒**且** AST 显示输出被重定向到文件                                                       | 声明上界不是等待证据；输出入文件才可能真静默          |
| `tail-follow`  | AST 里的 `tail -f` / `-F`，且那一条命令的 stdout 没有重定向到文件（含 `-n 40 -f`、`-20f`）                         | 跟随模式永不自己退出；`grep -m1` 只杀下游            |
| `unparseable`  | 解析错误、动态命令名、不可解析的 `sleep` 参数、嵌套 `-c`/替换超过 8 层、无法处理的 AST 节点                        | 判不出来不能当放行                                    |

`sleep` 的后缀按 GNU sleep 换算（`s`/`m`/`h`/`d`）。`for` 的迭代次数能从 `1 2 3`、`$(seq 1 30)`、`{1..30}` 静态算出；算不出来就按无界处理。循环体里的 `echo`、`curl`、`ps | awk` 算可见输出；`grep -q`、`[ ... ]`、`break`、`sleep` 不算。

## 放行示例

`sleep 5`、`sleep 10s`、引号里的 `sleep 30`、`#` 注释里的 `sleep`、`timeout` 200、heredoc 正文里的循环、`tail -n 40 <log>`、`tail -f a.log > /tmp/b.log`。

这两天会话里被文本扫描误拦、现在放行的形状：

```shell
make -C doop-docker start-hiragino 2>&1 | tail -10
for i in $(seq 1 20); do curl -fsS http://localhost:4300/healthz >/dev/null 2>&1 && echo "healthy on try $i" && break; sleep 1; done

for i in $(seq 1 10); do ps -o pid=,rss=,command= -p 52176 | awk '{print $1, $2"KB", $3}'; sleep 1; done

# 工具 timeout 只是上界；commit + push 约 36 秒就结束
git commit -m 'fix(test): ...' && git push origin master 2>&1 | tail -25   # timeout=400
```

仍拦：`for i in $(seq 1 50); do glab ci status | head -3; sleep 20; done`（单次 20 秒）、`until [ -f /tmp/x ]; do sleep 2; done`（无输出、无界）、`sleep 20`、`make check > /tmp/check.log 2>&1`（timeout=900）。

## 拦下来之后用什么

reason 里统一给通用的等待形状，不假设任何仓库装了特定脚本：

1. 把长任务放后台跑，输出写进日志；
2. 用一次带 `timeout` 的查询等到结论，每约 10 秒打印一行进度（所以不撞 `sleep-loop`）；
3. 本仓若有 wait helper（例如 pi-clients 的 `tools/wait-log.sh`），直接用它，省掉自己拼。

pi-clients 那份脚本的退出码契约是 `0` 命中 / `124` 超时 / `125` 被盯进程先退出；这是它的局部约定，guard 文案不依赖这些码。

**不拼「把你的循环换成 timeout N xxx」这类具体命令**：`guard.ts` 不负责理解命令语义，猜错了会静默丢掉检查。沿用「拦截而不是改写」这条既有原则。

## 环境变量

| 变量                        | 默认  | 作用                                                   |
| --------------------------- | ----- | ------------------------------------------------------ |
| `PI_BASH_GUARD_MAX_SECONDS` | `300` | `long-timeout` 的上限；只有输出被捕获的长调用才受约束  |
| `PI_BASH_GUARD_DISABLED`    | 未设  | 设成 `1` 关闭本扩展的全部拦截                          |

## 验证

```shell
npx vitest run extensions/bash-block-guard          # 含 ast-regressions.test.ts 的会话 corpus
npm run typecheck
npm run lint
```
