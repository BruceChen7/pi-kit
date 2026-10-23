---

name: verify-pi-web
description: "pi-kit 插件在 pi-web（浏览器宿主）里的确定性验证：证明扩展被 pi-web 的 pi 运行时加载、斜杠命令在浏览器里产出可见 UI（状态行 / 自定义面板 / 回到会话的输出），并留下可复跑证据。Use for /verify-pi-web、\"这个插件在 pi-web 里能用吗\"、改完 extensions/ 或 shared/ui-host 后要证明浏览器宿主没退化、或要给某个插件补一条 pi-web recipe 时。"
---

# pi-kit plugin verification on pi-web

`npm test` 证明进程内逻辑，[`verify-pi-kit`](../verify-pi-kit/SKILL.md) 证明 pi 运行时加载了插件。这个 skill 证明第三件事：**同一批插件在 pi-web（浏览器宿主）里真的画出东西**。

pi-web 报 `mode: "rpc"`，却真的实现 `ctx.ui.custom`；pi 自带的 rpc 模式同名方法会不问就 resolve `undefined`。所以「在 pi 里能用」推不出「在 pi-web 里能用」，这两条路径必须分别取证。

不驱动 TUI，不驱动用户自己开着的 pi-web（30141 那个），不跑模型回合。

## 句柄版本

下面所有 DOM 句柄与 API 路径按 **pi-web 0.12.2** 实际核对：`/api/agent/new` + `/api/agent/<id>` 的 `get_commands`、`?cwd=`、`.chat-input-textarea`、`div[role="dialog"]`、`div[role=status]`、`opencli browser ... keys Enter`。pi-web 升级后先用 `doctor` 复跑一次；句柄变了就改 recipe，并在 feature 的 `Gotchas` 里写清是哪个句柄换了。

跑通的样本证据：`.pi/verify-runs/20261021-193444-plan-mode+skill-toggle/`（doctor + 三个 feature 的截图与 state 快照）。

## Launch

一条命令起一个隔离实例：只挂目标插件，只写临时 agent 目录，端口自己占。

```bash
node scripts/verify-pi-web.mjs serve --plugin plan-mode --plugin skill-toggle --port 30242
```

输出 JSON，记下 `runDir`、`port`、`pid`、`baseUrl`、`evidenceDir`。做了三件事：
1. 建 `<runDir>/agent/extensions/`，把 `extensions/<plugin>` 与 `extensions/shared` 软链进去。pi 的扩展发现走 agent 目录的 `extensions/`，所以挂什么就是什么。
2. `PI_CODING_AGENT_DIR=<runDir>/agent` 起 `pi-web --port <port> --no-open`，会话文件、auth、模型缓存全落在 runDir 里，不碰 `~/.pi/agent`。
3. 轮询 `GET /api/sessions` 到 200。

Ready 只代表进程应答。**能加载扩展**是 Doctor 的事。

`runDir` 默认 `.pi/verify-runs/<yyyymmdd-hhmmss>-<plugin>+<plugin>/`。`--run-dir` 可指定。

## Doctor

```bash
node scripts/verify-pi-web.mjs doctor --run-dir <runDir> --plugin plan-mode --expect-command plan-mode
```

判定靠 pi-web 自己的 pi 运行时报出来的命令表，不是看日志：
1. `POST /api/agent/new {cwd, type: "ensure_session"}` 拿到真实 `sessionId`。
2. `POST /api/agent/<sessionId> {type: "get_commands"}` 拿到命令表。
3. 只认 `sourceInfo.path` 落在 `<runDir>/agent/extensions/` 下的命令。落在别处的不算这个 run 的插件（用户 `~/.agents/skills` 的 skill 命令会是几十条噪音（本机 26 条），正常）。

退出码：`0` 通过，`1` 插件或命令没出现，`2` 参数错误。证据写在 `runDir/commands.json` 与 `runDir/doctor.json`。

Doctor 通过 = 插件在 pi-web 的运行时里加载成功。它不证明 UI 画出来了，那要靠 Drive。

## Drive

浏览器用 `opencli`。每个 run 一个浏览器 session 名，避免和别的活串台。

```bash
CWD=$(node -e 'console.log(encodeURIComponent(process.cwd()))')
opencli browser piweb-probe open "http://127.0.0.1:30242/?cwd=$CWD"
```

`?cwd=` 直接选中项目，等价于在界面上点「选择项目…」。页面 locale 跟随浏览器，所以**只断言插件自己输出的英文文本**，不要断言 pi-web 的界面文案。

发一条斜杠命令，三步缺一不可：

```bash
opencli browser piweb-probe fill ".chat-input-textarea" "/plan-mode status"
opencli browser piweb-probe click ".chat-input-textarea"
opencli browser piweb-probe keys Enter
```

`fill` 只改值，不落焦点；不先 `click` 的话 `keys Enter` 发不出去（实测，值留在框里）。

发完先确认发出去了，再断言 UI：

```bash
opencli browser piweb-probe state | grep "chat-input-textarea"
```

框里还留着刚才那行（`value=/toggle-skill`）= 没发出去。上一条命令刚结束、composer 还没回到空闲态时，Enter 会被丢掉；重新 `click` + `keys Enter` 一次即可。别把这个当成插件失败。

观测点按插件用哪个 UI 面来选，recipe 在 feature map：
- 会话输出：`opencli browser piweb-probe state` 里出现插件写的那行英文。
- 状态行：`div[role=status]` 的 `aria-label` 就是插件调的 `setStatus` 文本。
- 自定义面板：`div[role="dialog"]` 存在，面板内是插件自己 `render()` 出来的文本（ANSI 转成的 HTML）。
- 通知：`ctx.ui.notify` 的文本出现在会话流里。

关闭面板用 `keys Escape`。命令在面板关闭后才返回，别在面板开着时继续打字（见 Gotchas）。

## Evidence

一次 run 的证据全在 `runDir` 里，cleanup 之后仍然在：
- `launch.json`：端口、pid、agentDir、插件清单。
- `commands.json` / `doctor.json`：Doctor 的原始命令表与判定。
- `evidence/<feature>.png`：`opencli browser <s> screenshot <path>`。
- `evidence/<feature>.state.txt`：`opencli browser <s> state > <path>`，动作前后的 DOM 快照。
- `pi-web.log`：服务端输出。

证明标准：
- 断言落在**插件输出的文本**或 `role=dialog` / `role=status` 这类稳定句柄上。
- 一次 drive 至少留下「动作命令 + 截图 + state 快照」三样。
- 面板类证据要包含面板里的插件文本（例如 `Skill Picker (`），不能只有一张空截图。
- 失败也要留证据，并在报告里写清是哪一重信号失败：插件没加载、命令没注册、还是 UI 没出现。

## Cleanup

```bash
node scripts/verify-pi-web.mjs stop --run-dir <runDir>
opencli browser piweb-probe close
```

`stop` 只杀 `launch.json` 里那个 pid，然后等端口释放。**不要按进程名 kill**，30141 上可能跑着用户自己的实例。证据不删：`runDir` 留着，报告里贴路径。

## Helpers

`scripts/verify-pi-web.mjs`，三副子命令，纯函数部分（`parseArgs` / `buildPlan` / `classifyCommands` / `judge`）与 shell 分开，`scripts/verify-pi-web.test.ts` 覆盖。

```bash
node scripts/verify-pi-web.mjs serve  --plugin <name> [--plugin <name> ...] [--port 30242] [--cwd <dir>] [--run-dir <dir>]
node scripts/verify-pi-web.mjs doctor --run-dir <dir> [--plugin <name>] [--expect-command <cmd>] [--cwd <dir>]
node scripts/verify-pi-web.mjs stop   --run-dir <dir>
```

浏览器步骤不进 helper：opencli 的 state/screenshot 输出就是证据本身，套一层脚本只会让证据多一跳。

## Gotchas

- **不要碰 30141**。`make pi-web` 起的是用户的常驻实例，里面是他真实的会话。验证只驱动本 run 用 `serve` 起的端口。
- `fill` 之后必须 `click` 再 `keys Enter`。`fill` 只写值不改焦点，直接按 Enter 什么都不会发。
- 发送按钮的 `title` 是界面文案（中文是 `发送`，英文是 `Send`）。要跨 locale 就别选它，用 Enter。
- 自定义面板打开时 composer 被换掉（`引导` / `后续消息`），键盘输入进面板。面板没关就继续往 `.chat-input-textarea` 打字，会把半截命令留在框里，下一次发送变成脏数据。`keys Escape` 关掉再继续。
- 面板关闭后命令才 resolve。面板里做的选择会写用户级状态（`/toggle-skill` 改 skill 开关）。验证只读打开、`Escape` 关闭，不要在里面按 Enter。
- `/plan-mode plan` 会改会话模式并留下 `role=status` 的状态行，跑完用 `/plan-mode act` 还原，否则下一个 feature 的断言会看到一个 Plan 状态。
- 隔离的是 agent 目录，不是 skills 目录：`~/.agents/skills` 仍然会被加载，所以 `get_commands` 里有大量非本 run 的命令。判定只看 `sourceInfo.path`。
- `PI_CODING_AGENT_DIR` 指向空目录时 pi 仍会解析出一个默认模型（本机实测 `anthropic/claude-opus-4-8`）。别写成「没配模型就不能验证」。
- **widget（`setWidget`）这一面没有覆盖**：现役插件里没有一个在无模型、无既有会话状态下会挂 widget（`codex-plan-limits` 要 codex 模型，`plan-mode` 的 TODO widget 要有 TODO）。要验这一面，先挑一个能确定性触发 widget 的插件，再加 feature 文件。
- 改过这个 skill 或它带的 helper 后，跑 `/reload` 或重开会话，否则当前会话里的 agent 看不到新内容。

## 维护

插件命令名、notify 文本、面板标题变了，或 pi-web 升级改了 DOM 句柄，用 [`/skill:maintain-verification-skill`](../maintain-verification-skill/SKILL.md) 让 map 跟上。pi-web 升级后先复跑 `doctor`：`sourceInfo` 路径断言能第一时间抓出「扩展不再从 agent 目录加载」。
