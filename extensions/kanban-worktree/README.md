# kanban-worktree

`kanban-worktree` 是 pi-kit 里的 Pi extension，注册 `/kanban-worktree` 命令，用于从
TODO/requirement 创建 feature worktree，并在 tmux 中启动对应的 Pi agent。

## 运行前提

- 已安装 Node.js 与 npm。
- 已安装 `tmux`，因为 launch 会在 tmux window 中启动 Pi agent。
- 在 git repo 根目录运行；插件会读写当前 repo 的 `.pi/todos.json`。
- 已安装本仓库依赖：

```bash
npm install
```

> 注意：这个目录不是完全独立的单插件包。它依赖相邻模块：
> `extensions/shared`、`extensions/feature-workflow`、`extensions/todo-workflow`。
> 推荐把整个 `pi-kit` 作为 Pi package 安装/加载，而不是只复制本目录。

## Glimpse UI 依赖

`/kanban-worktree open` 使用 npm 包 `glimpseui` 的 native host 打开本地 Glimpse 窗口。该依赖在根目录
`package.json` 中声明为普通 npm dependency，运行 `npm install` 会自动安装。

Kanban worktree 通过 `getNativeHostInfo()` 获取 host 路径后自行 spawn，并关闭 native stderr，
避免 Glimpse 调试输出污染 Pi/TUI。stdin/stdout 仍使用 Glimpse JSON Lines 协议。

当前 `glimpseui` 包没有自带 TypeScript declaration，本插件在
`extensions/kanban-worktree/glimpseui.d.ts` 中维护最小类型 shim，只描述
`glimpse-host.ts` 当前用到的 `getNativeHostInfo()`、`window.on("message")` 和 `window.send()`。
如果未来 `glimpseui` 发布官方类型，可以删除这个本地 shim。

## 编译 UI

Pi extension 的 TypeScript 入口由 Pi 运行时直接加载，不需要单独 tsc 编译。
需要编译的是 Glimpse/Svelte UI：

```bash
npm run kanban-worktree:ui:build
```

该命令会执行：

```bash
vite build --config extensions/kanban-worktree/vite.config.mts
```

输出目录：

```text
extensions/kanban-worktree/ui-dist/
```

`ui-dist/` 是生成产物，已放入 `.gitignore`，不会作为源码提交。`/kanban-worktree open`
会读取 `ui-dist/index.html` 并内联构建产物；如果本地没有先构建 `ui-dist`，打开 UI
会失败或展示旧内容。

## 本地加载/运行

### 临时加载当前仓库

从 `pi-kit` 仓库根目录启动：

```bash
npm install
npm run kanban-worktree:ui:build
pi -e .
```

然后在 Pi 中运行：

```text
/kanban-worktree open
```

常用命令：

```text
/kanban-worktree start              # 启动 daemon
/kanban-worktree status             # 查看 daemon 状态
/kanban-worktree open               # 打开 Kanban UI
/kanban-worktree list               # 列出 requirements
/kanban-worktree create <title>     # 创建 requirement（调试用）
/kanban-worktree stop               # 停止当前 extension 持有的 daemon 子进程并删除 socket
```

### 作为本地 Pi package 安装

推荐使用整个仓库目录作为本地 package：

```bash
npm install
npm run kanban-worktree:ui:build
pi install /absolute/path/to/pi-kit
```

项目级安装可在目标项目中使用 `-l`：

```bash
pi install -l /absolute/path/to/pi-kit
```

安装后重启 Pi 或运行 `/reload`，再使用：

```text
/kanban-worktree open
```

## 打包/发布检查

从仓库根目录执行：

```bash
npm install
npm test -- extensions/kanban-worktree
npm run lint
npm pack --dry-run
```

`package.json` 的 `prepack` 会在 `npm pack`/`npm publish` 前自动运行
`npm run kanban-worktree:ui:build`，生成被 git ignore 的 `ui-dist/`。根目录 `.npmignore`
会保留该构建产物进入 npm 包。仍然需要检查 `npm pack --dry-run` 输出中包含：

- `extensions/kanban-worktree/index.ts`
- `extensions/kanban-worktree/run-daemon.ts`
- `extensions/kanban-worktree/ui-dist/index.html`
- `extensions/kanban-worktree/ui-dist/assets/*`
- `extensions/shared/*`
- `extensions/feature-workflow/*`
- `extensions/todo-workflow/*`

如果要发布到 npm：

```bash
npm publish
```

发布后用户可通过 npm package 安装：

```bash
pi install npm:pi-kit@<version>
```

## package.json 配置

根目录 `package.json` 已经声明：

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/kanban-worktree"]
  }
}
```

实际仓库中 `pi.extensions` 还会加载 pi-kit 的其他扩展。只要通过 `pi -e .`、
`pi install /path/to/pi-kit` 或 npm package 加载整个仓库，`/kanban-worktree` 命令就会注册。

## 故障排查

- **没有 `/kanban-worktree` 命令**：确认已通过 `pi -e .` 或 `pi install /path/to/pi-kit` 加载整个 package，并重启 Pi 或 `/reload`。
- **`open` 失败或 UI 为空**：重新运行 `npm run kanban-worktree:ui:build`，确认 `ui-dist/index.html` 存在。
- **launch 失败**：确认当前在 git repo 内、`tmux` 可用，并且 TODO 有 `workBranch`。
- **daemon 状态异常**：先运行 `/kanban-worktree status`，必要时 `/kanban-worktree stop` 后重新 `/kanban-worktree open`。
