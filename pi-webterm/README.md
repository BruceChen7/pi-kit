# Pi WebTerm

**Pi WebTerm** 是一个独立的 Node.js 程序，让你在手机上（或任何浏览器）通过
WebSocket + tmux 远程访问本地的 [Pi](https://github.com/earendil-works/pi-coding-agent) 编码 Agent。

```
┌──────────┐  WS  ┌──────────────┐ node-pty ┌──────────┐  PTY ┌──────────┐
│  Svelte  │◄────►│  Node.js     │◄────────►│  tmux    │◄────►│  pi /    │
│  xterm   │      │  守护进程     │          │  持久化   │      │  claude  │
│  PWA     │      │  Fastify     │          │  层      │      │  codex   │
└──────────┘      │  + node-pty  │          └──────────┘      └──────────┘
                  └──────────────┘
```

## 功能

- **手机访问**：通过 PWA + xterm.js 在手机上使用 Pi
- **会话持久化**：tmux 保持 Agent 运行，浏览器断开不影响
- **实时 I/O**：node-pty 实时双向通道，无需轮询
- **安全认证**：Ed25519 签名 + Token 降级方案
- **多 session**：tmuxSessionName 自动包含工作目录名，项目间隔离

## 快速开始

```bash
# 构建 UI + 启动
make run

# 或者分步执行
make build
make dev
```

启动后访问 `http://<本机IP>:4730`，输入 Token 即可连接。

## 配置

| 选项 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--port` | `PI_WEBTERM_PORT` | 4730 | 监听端口 |
| `--host` | `PI_WEBTERM_HOST` | 0.0.0.0 | 监听地址 |
| `--token` | `PI_WEBTERM_TOKEN` | 自动生成 | 认证 Token |
| `--agent` | `PI_WEBTERM_AGENT` | pi | Agent 命令 |
| `--cwd` | `PI_WEBTERM_CWD` | process.cwd() | 工作目录 |
| `--no-auto-start` | — | — | 不自动启动 Agent |

### 命令行

```bash
npm run dev -- --port 8080 --token my-token
node src/index.ts --port 8080 --agent claude
```

### 环境变量

```bash
export PI_WEBTERM_PORT=8080
export PI_WEBTERM_TOKEN=my-secret-token
npm run dev
```

## Protocol

WebSocket 使用混合二进制/JSON 协议：

```
┌─────┬──────────┬────────────────────────────┐
│ 1字节 │ 变长     │ 变长                       │
│ 类型  │ sessionId│ 数据                       │
├─────┼──────────┼────────────────────────────┤
│ 0x00 │ "pi-agent"│ 原始 ANSI 字节 (终端 I/O)  │ ← 二进制帧
│ 0x01 │ —        │ JSON 字符串 (控制消息)      │ ← JSON 帧
└─────┴──────────┴────────────────────────────┘
```

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/setup` | 获取公钥和 Token 提示 |
| GET | `/api/sessions` | 列出 session |
| POST | `/api/sessions` | 创建 session |
| DELETE | `/api/sessions/:name` | 删除 session |

API 需要 `Authorization: Bearer <token>` header。

## 开发

```bash
# 运行测试
make test

# 监听模式
make test-watch

# 类型检查
make typecheck

# 清理
make clean
```

## License

MIT
