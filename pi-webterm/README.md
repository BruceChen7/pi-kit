# Pi WebTerm

**Pi WebTerm** 是一个独立的 Node.js 程序，让你在手机上（或任何浏览器）通过
WebSocket + tmux 远程访问本地的 [Pi](https://github.com/earendil-works/pi-coding-agent) 编码 Agent。

```
┌──────────┐  WS   ┌──────────────┐ node-pty       ┌──────┐  PTY  ┌──────────┐
│  Svelte  │◄─────►│  Node.js     │◄──spawn──►     │ tmux │◄─────►│  pi /    │
│  xterm   │       │  守护进程     │  tmux attach    │ 持久化│       │  claude  │
│  PWA     │       │  Fastify     │  -session       │ 层   │       │  codex   │
└──────────┘       │  + node-pty  │                └──────┘       └──────────┘
                   └──────────────┘
```

## 功能

- **手机访问**：通过 PWA + xterm.js 在手机上使用 Pi
- **会话持久化**：tmux 保持 Agent 运行，浏览器断开不影响
- **实时 I/O**：node-pty 实时双向通道，无需轮询
- **安全认证**：用户名/密码登录 → Bearer Token → WebSocket 首次消息认证
- **多 Session 管理**：tmux session 命名规则 `pw__<dirname>__<branch>__<hash>`，项目间隔离
- **目录发现**：自动扫描工作空间下所有 git 仓库，快速创建 session
- **分支管理**：选择已有分支或创建新分支（基于指定 base 分支）
- **Session 快照恢复**：重连时通过 tmux capture-pane 拉取最近 200 行历史输出

## 快速开始

```bash
# 安装依赖 + 启动开发服务器 (tsx watch 模式)
make dev

# 或分步执行
make install         # 安装 server + UI 依赖
make build           # 构建 UI (vite build → ui/dist/)
make run             # 构建 UI + 启动服务
```

启动后访问 `http://<本机IP>:4730`，输入用户名和密码即可登录。

## 配置

| 选项 | CLI 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|---------|--------|------|
| 端口 | `--port`, `-p` | `PI_WEBTERM_PORT` | 4730 | 监听端口 |
| 地址 | `--host` | `PI_WEBTERM_HOST` | 0.0.0.0 | 监听地址 |
| 用户名 | `--username`, `-u` | `PI_WEBTERM_USERNAME` | admin | 登录用户名 |
| 密码 | `--password`, `-pwd` | `PI_WEBTERM_PASSWORD` | admin | 登录密码 |
| Agent 命令 | `--agent` | `PI_WEBTERM_AGENT` | pi | Agent 启动命令 |
| 工作目录 | `--cwd` | `PI_WEBTERM_CWD` | process.cwd() | Agent 工作目录 / 目录发现 base path |
| 数据目录 | `--data-dir` | `PI_WEBTERM_DATADIR` | ~/.pi/pi-webterm/ | 持久化配置存储 |
| 不自动启动 Agent | `--no-auto-start` | `PI_WEBTERM_AUTOSTARTAGENT` | — | Agent 仅在 WS 连接时 attach |

> 安全警告：`0.0.0.0` 上暴露时需 8+ 字符强密码。

### CLI 示例

```bash
cd server && npx tsx src/index.ts --port 8080 --username admin --password my-secret-pwd
cd server && npx tsx src/index.ts --agent claude --cwd /path/to/project
```

### 环境变量示例

```bash
export PI_WEBTERM_PORT=8080
export PI_WEBTERM_USERNAME=admin
export PI_WEBTERM_PASSWORD=my-secret-pwd
cd server && npx tsx src/index.ts
```

## 使用

### 创建 Session

1. 登录后，在 Session 选择界面点击"新建 Session"
2. **搜索或输入工作目录**：自动显示扫描到的 git 仓库列表，支持输入过滤
3. **选择分支**：选中目录后自动加载该仓库的所有本地分支
4. **创建新分支**：选择"创建新分支"，输入分支名并选择 base 分支
5. 点击"创建并连接"

Session 命名规则：`pw__<项目名>__<分支>__<hash(路径,4)>`

- 相同路径+分支的重复创建 → 自动 attach 已有 session
- 不同路径但同项目名 → hash 后缀区分（UI 只在需要时显示）

### Session 管理

- 侧边栏列出所有 session，点击切换
- 状态指示：● 运行中 ▲ 崩溃 ⏳ 启动中 ■ 已停止
- 可删除不再需要的 session

## REST API

所有端点（除 `/api/health`、`/api/setup`、`/api/login` 外）均需 `Authorization: Bearer <token>` header。

### Session 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/setup` | 获取服务器信息 |
| `POST` | `/api/login` | 用户名/密码登录，返回 master token + session 列表 |
| `POST` | `/api/logout` | 登出 |
| `GET` | `/api/sessions` | 列出所有 session |
| `POST` | `/api/sessions` | 创建新 session |
| `GET` | `/api/sessions/:name` | Session 详情 |
| `POST` | `/api/sessions/:name/attach` | Attach 到 session |
| `DELETE` | `/api/sessions/:name` | 删除 session |

### 目录发现

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/workspace/directories` | 返回扫描到的 git 仓库列表（含本地分支） |
| `POST` | `/api/workspace/refresh` | 手动触发重新扫描 |

### 创建 Session 请求体

```json
{
  "cwd": "/path/to/repo",
  "branch": "main",
  "baseBranch": "main",
  "agentCommand": "pi"
}
```

- `cwd`：工作目录（必填，UI 自动从目录选择器传入）
- `branch`：分支名（选填，默认自动检测）
- `baseBranch`：当创建新分支时，指定 base 分支（选填）
- `agentCommand`：Agent 启动命令（选填，默认使用配置值）

### WebSocket 认证

WebSocket 连接 `/ws` 需要通过第一条消息进行认证：

```json
{
  "type": "auth",
  "token": "<session-token>"
}
```

认证成功后即可进行终端 I/O。

## Session 命名规则

```
pw__<dirname>__<branch>__<hash>
```

| 部分 | 说明 |
|------|------|
| `pw__` | 固定前缀，标识 pi-webterm 管理的 session |
| `<dirname>` | 项目名（工作目录的 basename） |
| `<branch>` | git 分支名（`/` 会被 sanitize 为 `_`） |
| `<hash>` | 路径的 SHA256 前 4 位，用于区分同项目不同路径 |

旧格式 `pw__<dirname>__<branch>`（无 hash）仍然兼容。

## 开发

```bash
make test           # 运行测试
make test-watch     # 监听模式
make typecheck      # 类型检查
make clean          # 清理构建产物
```

## License

MIT
