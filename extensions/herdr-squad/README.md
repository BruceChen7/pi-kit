# Herdr Squad

在 [Herdr](https://herdr.dev) 中创建可见的、严格只读的 Pi 调查小队（1-4 个子 agent），用于并行代码侦查。

## 前置条件

- Pi 运行在 Herdr 管理的面板中（`HERDR_ENV=1`）
- 安装后执行 `/reload` 或重启 Pi

## 使用方法

### 命令式

```
/herdr-squad <count|auto> <task>
```

示例：

```
/herdr-squad 3 调查结账失败
/herdr-squad auto 审计认证模块改造成本
/herdr-squad 2 compare frontend and backend validation
```

### 自然语言

agent 能自动识别，无需命令：

```
启动一个 2 个 agent 的 Herdr squad，对比前后端验证逻辑
```

## 工作流程

```
用户触发
  │
  ▼
Herdr Squad skill
  → 规划不重叠的 scope
  → 执行三步 tool 顺序
  → 综合报告

三步 tool（强制顺序，各占一个 model turn）：
  ① herdr_squad_start    → 建 tab + 分割 pane + 启动子 agent
  ② herdr_squad_wait     → 轮询报告，处理超时/阻塞
  ③ herdr_squad_collect  → 收集结构化报告 + 终端兜底
```

子 agent 是**严格只读**的，只拿到 `read`、`grep`、`find`、`ls`、`herdr_squad_report` 五个工具。

## 配置

模型选择优先级：

1. `herdr_squad_start` 显式传入的 `model` 参数
2. 项目配置 `.pi/third_extension_settings.json` 中 `herdrSquad.defaultModel`
3. 全局配置 `~/.pi/agent/third_extension_settings.json` 中 `herdrSquad.defaultModel`
4. Pi 默认模型

项目配置示例（`.pi/third_extension_settings.json`）：

```json
{
  "herdrSquad": {
    "defaultModel": "openai-codex/gpt-5.6-terra"
  }
}
```

设为 `null` 则回退到 Pi 默认模型。

## 文件结构

```
extensions/herdr-squad/
├── README.md       ← 本文件
├── index.ts        ← 父 orchestrator（3 个 tool）
├── child.ts        ← 子 agent 端注册（herdr_squad_report）
├── config.ts       ← 模型配置解析
└── shared.ts       ← 类型定义 + 工具函数

skills/herdr-squad/
└── SKILL.md        ← skill 工作流

prompts/herdr-squad.md  ← /herdr-squad 命令入口
```

## 安全设计

- 子 agent 没有 `bash`、`edit`、`write`
- 子 agent 身份通过 HMAC 风格 token 验证
- 运行目录路径完整性检查（符号链接检测）
- 报告文件原子写入（临时文件 + rename）
- prompt 文件 `mode 0o600`
- manifest 文件写保护

## 来源

移植自 [jillesme/pi-herdr-squad](https://github.com/jillesme/pi-herdr-squad) (v0.1.3)，MIT 协议。
