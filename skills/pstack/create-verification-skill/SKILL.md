---
name: create-verification-skill
description: "给一个仓库生成项目级验证 skill：按用户路径启动、驱动、取证、清理，任何语言或平台。Use for /create-verification-skill、给这个仓库做一套可控的验证流程，或项目没有脚本化方式证明 UI / CLI / 服务行为时。"
disable-model-invocation: true
---

# Create a verification skill

每个项目都需要一条脚本化的路径来驱动真实应用并证明行为：启动它，按用户的方式走一个功能，留下证据。这个 skill 把这件事生成为项目级 skill（`.pi/skills/verify-<app>/`），按仓库定制。你写的是给下一个 agent 的产物，不是给人读的说明：它会在一无所知的情况下被冷读。

## 1. 问仓库，不问人

能从代码里答的就自己答，只问观察不到的部分：

- **界面**：用户实际碰的是什么？Web UI、CLI/TUI、桌面应用、API、移动端，还是库？一个仓库可能有多个，选主的，其余记下来。
- **启动**：本地怎么起？优先用仓库自己的 dev 命令（package scripts、Makefile、README quickstart）。记端口、env、种子数据、鉴权。
- **驱动**：agent 怎么用程序方式交互？先找已有 harness：Playwright / Cypress specs、expect 脚本、PTY 工具、可 curl 的端点、debug 端口。没有再用通用做法：Web 与 Electron 用 `opencli-browser` 或 `terminal-browser`，CLI/TUI 用 tmux / PTY，服务用 HTTP。不要假设 Playwright 已安装。
- **观测**：能留下什么证据？截图、终端记录、响应体、日志、退出码、数据库状态。
- **隔离**：两个实例能并排跑吗（端口、数据目录、profile）？不能就在生成的 skill 里写明：拒绝双开共享实例，比弄坏用户会话好。

如果 checkout 起不来，先修或精确报告，再生成。对一个坏底座写出的 skill 会教错步骤。无关的缺失资产挡住启动（API 不服务的静态目录、示例配置）时，生成的 skill 可以创建它，标明是验证脚手架，并在 cleanup 里删掉。

## 2. 生成 skill

写 `.pi/skills/verify-<app>/SKILL.md`，frontmatter 用 `name: verify-<app>` 与一个 description（写明 app、界面类型、什么时候用它；没有 frontmatter 就不会注册）。不要写 `disable-model-invocation: true`：它会让生成物从 system prompt 消失，agent 只能靠手敲 `/skill:` 调用，而项目验证 skill 正是给 agent 自己用的。下面每一节都落在第 1 步实际找到的东西上，不留占位符：

- **Launch**：验证时启动应用的准确命令，以及怎么判断 ready（日志行、提示符）。Launch 必须从空数据目录到可用状态，包含 migration 与 seed。Ready 是可用，不只是进程应答。数据库健康检查可能过，init 脚本还在跑。写 teardown。短命 CLI/TUI 没有常驻 server：launch 指构建一次，然后每次 drive 在自己的 PTY 或 tmux 会话里起。
- **Doctor**：一条只读检查，回答「这个实例值不值得驱动」：进程在、版本/构建对、端口是我们的、鉴权有效。任何异常先跑它。
- **Drive**：harness 的具体步骤与真实选择器/命令，不是示例。优先稳定句柄（ARIA label、data 属性、提示符、路由路径），不要坐标与 tab 顺序。
- **Evidence**：证明要留什么、放哪。证明标准：走真实用户路径，不走内部 setter 或测试专用端点；记录动作与结果状态，不只最后一屏；可见结果之外验副作用（写文件、插行、发消息）；只在生产边界已隔离外部系统时用 mock。安全路径是 dry-run 或 test mode 时，要观察它实际跳过了什么（文件、网络、git ref），不要信名字：有些 dry-run 仍会碰网络或开浏览器。
- **Cleanup**：怎么拆掉这次起的实例。不要按进程名 kill，只 kill 自己起的。Cleanup 删实例与临时状态，不删证据：证明产物要活过 teardown，放在 skill 写明的路径。
- **Helpers**：skill 带的脚本要可执行，调用方式写在正文里。需要读者逆向的脚本不是 helper。

## 3. 种 feature map

创建 `.pi/skills/verify-<app>/features/README.md`，再加每个用户可见功能一个文件（先 3–5 个，从路由、命令、菜单或文档里找）。按 [`references/feature-map-example/README.md`](references/feature-map-example/README.md) 的形状写：README 索引 + 每功能一个文件。每个文件从用户视角回答：功能是什么、怎么到、怎么用 harness 驱动、什么可观察的终态证明它可用。四个 H2 固定为 `Sub-features`、`How to get to it (user POV)`、`Driving it with <harness>`、`Gotchas`。种子数据缺某个前置条件时，这条 journey 报失败，原因写进该功能的 `Gotchas`。不要为了让 journey 通过而弱化它。地图是这个仓库的验证真源；只驱动一个方便入口的证明，在地图列了其他入口时不算完整。

## 4. 交付前先证明生成的 skill

按它自己的说明从头到尾跑一次：launch、doctor、drive 一个已映射功能（一个就够；地图存在是为了以后覆盖其余）、留证据、cleanup。cleanup 后确认证据还在指定位置。cleanup 吃掉证明，这一步就失败。修掉失败项；每次失败迭代也要跑生成的 cleanup，别把进程和端口留在那。没跑过的生成 skill 是草稿，不是交付物。如果在替身里证明（容器代替新 VM、本地栈代替远端），列出替身做了而目标不会做的每一步。这些步骤在真实目标跑过之前都算未验证。

## 5. 让 agent 看得到它

skill 只在 pi 启动时进 system prompt。生成或改完后，告诉用户跑 `/reload` 或重开会话。当前会话里新建的文件不会自动出现，agent 看不到就只能手敲 `/skill:` 加 skill 名。

## 6. 指向维护环

告诉用户用 `/maintain-verification-skill` 在应用变化时保持地图诚实。用户问节奏再建议。
