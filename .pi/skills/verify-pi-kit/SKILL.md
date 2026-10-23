---

name: verify-pi-kit
description: "pi-kit 扩展的确定性验证：证明某个 plugin 真的被 pi 加载、斜杠命令产出了用户可见输出、注册的工具进了工具集，并留下可复跑证据。Use for /verify-pi-kit、'check 一下 plan-mode'、'这个插件还正常吗'、改完 extensions/ 要证明还能用、或需要给某个 plugin 补一条验证 recipe 时。"
---

# Pi-kit plugin verification

pi-kit 是扩展集合，`npm test` 只证明进程内逻辑。这个 skill 证明运行时的东西：pi 有没有加载它、命令有没有被扩展处理、用户能不能看到输出、工具在不在工具集里。

每条断言都变成一条可复跑的命令和一份证据文件。不要用「打开 TUI 看一眼」作为结论。

## Launch

不需要单独起服务。每次验证由 helper 起一个一次性的 pi：
- 命令模式：`pi --mode rpc --no-session --no-extensions --no-skills --no-mcp --no-prompt-templates --no-themes --offline -e <repo>/extensions/<plugin>`
- 工具 / doctor 模式：`DefaultResourceLoader({ noExtensions: true, additionalExtensionPaths: [<plugin>] })` + `createAgentSession`

前置条件：在 pi-kit 仓库根目录；`npm install` 跑过（helper 要 resolve `@earendil-works/pi-coding-agent`）；`pi` 在 PATH。

隔离是有意的：只加载目标扩展，其他扩展的注册和启动副作用不会污染结论。

## Doctor

先问「这个实例值不值得驱动」：

```bash
node scripts/verify-plugin.mjs doctor --plugin plan-mode
```

通过 = 扩展出现在 SDK 的加载结果里，且没有加载错误。输出 active tools 数量。失败就别往下走，先修加载。

doctor 只证明扩展文件加载成功，不证明它注册了什么。缺 `ATLASSIAN_CONFLUENCE_BASE_URL` 时 confluence 的 doctor 照样 PASS，只有 `tool` 模式会报 `tool "confluence_page" is not registered`。

## Drive

命令（斜杠命令的用户可见输出）：

```bash
node scripts/verify-plugin.mjs command --plugin plan-mode --command "/plan-mode status" --expect "Plan Mode: Act"
```

三重信号，缺一不算通过：
1. `get_commands` 里有这个命令，且 `sourceInfo.path` 指向目标扩展目录。
2. `prompt` 响应的 `disposition` 是 `handled`。`started` 表示没有扩展接手，命令名写错了。
3. 有一条 `notify` 文本命中 `--expect`。

`--command` 可重复（同一进程内按顺序执行）；`--expect` / `--reject` 对整次运行生效。期望值是**子串匹配**，不是前缀匹配，也不要拿它去断言整行（整行会带机器相关的设置）。

工具（`registerTool` 注册的工具）：

```bash
node scripts/verify-plugin.mjs tool --plugin confluence --tool confluence_page
```

通过 = 工具名在 `session.getActiveToolNames()` 里，且目标扩展没有加载错误。

退出码：`0` 通过，`1` 失败，`2` 参数错误。

具体 plugin 的字面命令在 feature map：先读 [features/README.md](features/README.md)。加新 plugin 只加一个 feature 文件，不改 helper。

不要为了让 recipe 过而放宽期望。失败时报告是哪一重信号失败：没注册、没 `handled`、还是 notify 文本不符。

## Evidence

每次运行写一个目录，默认 `.pi/verify-runs/<yyyymmdd-hhmmss>-<plugin>-<mode>/`。同一秒内同一 plugin + mode 再跑一次会自动加 `-2` 后缀，不覆盖前一次的证据。
- `transcript.jsonl`：命令模式的原始 RPC 记录。
- `active-tools.json`：工具 / doctor 模式的工具名列表。
- `summary.json`：判定、findings、steps、notifies。

证据在 helper 退出后仍然在。回答时贴证据路径，不要只贴「PASS」。

## Cleanup

helper 自己收尾：命令模式发 SIGTERM（不要 close stdin，实测会 EPIPE 崩溃），SDK 模式 `session.dispose()`。

运行卡住时只杀自己起的进程：

```bash
pgrep -fl "pi --mode rpc"
```

按 PID kill，不要按进程名批量 kill。证据不要删。

## Gotchas

- 新建或改过任何 skill 后，模型要 `/reload` 或重开会话才看得到。skill 只在启动时进 system prompt，当前会话里新建的文件不会自动出现。
- `disable-model-invocation: true` 会让 skill 从 system prompt 消失，只剩 `/skill:name` 点名可用。想让 agent 自己调用，就不要加这条。
- `get_commands` 看不到工具；工具必须用 `tool` 模式。
- 工具模式只证明注册，不证明调用。调用需要模型或外部账号，非确定性。
- 有些插件在加载时就改状态（如 `plugin-toggle` 的 bootstrap）。收录前先看它的 `session_start`。
- 只收只读命令。会写用户配置的命令不要进 map；helper 没有隔离 HOME。
- 命令模式的 stderr 有 model pattern 警告，那不是失败信号。判定只看返回记录。
- 改了扩展的命令名或 notify 文本后，用 `/skill:maintain-verification-skill` 让 map 跟上。
