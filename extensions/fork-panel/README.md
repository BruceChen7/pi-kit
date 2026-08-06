# Fork Panel

在当前 Herdr tab 内分叉当前 session tree 到新 panel：新 panel 启动一个**活的、可交互的 pi agent**，加载**同一个 session 文件**，从分叉点长出第二条真实分支并自动执行指定 prompt；旧 session 的 `/tree` 能看到两条真实分支（含 panel 的实时进展）。

## 前置条件

- Pi 运行在 Herdr 管理的 panel 中（`HERDR_ENV=1`）
- 安装后执行 `/reload` 或重启 Pi

## 使用方法

```
/fork-panel [--model <id>] <prompt>
```

示例：

```
/fork-panel 用 grill-me 流程审查这个设计
/fork-panel --model openai-codex/gpt-5.6-terra 调研缓存层并发问题
```

- prompt 为空时弹出编辑器输入
- prompt 以 `/` 开头时由 panel 内自然展开（panel 是完整 pi，技能/模板可用），如 `/fork-panel /skill:grill-me 审查这个设计`
- 模型优先级：`--model` 参数 > 项目配置 `forkPanel.defaultModel` > 全局配置 `forkPanel.defaultModel` > pi 默认（配置值为 `null` 显式回退默认）

项目配置示例（`.pi/third_extension_settings.json`）：

```json
{
  "forkPanel": {
    "defaultModel": "openai-codex/gpt-5.6-terra"
  }
}
```

## 行为

1. **分叉点**：命令执行时刻，在旧 session 的当前 leaf 下写入一个占位节点（`fork-panel` custom entry，不进 LLM 上下文，`/tree` 中渲染为 `→ fork-panel: <prompt 摘要>`），panel 从该节点长出分支。
2. **布局**：当前 tab 内 1 个 pane → 右侧 split；≥2 个 → 最右侧 pane 向下 split。新 panel 不抢焦点。
3. **panel**：`herdr agent start` 启动活的交互 pi（`--session <同一文件>`），`agent prompt` 提交初始 prompt（fire-and-forget，结果留在 panel 的 session 里）。
4. **旧 `/tree` 看到两条分支**：每次 `/tree` 前自动重读磁盘（refresh），旧 session 与 panel 双向可见对方分支最新进展。
5. **导航护栏**：旧 session 不能 `/tree` 导航进 panel 分支，panel 不能回旧分支（防双进程同分支写入）；想看对方进展请到对方 panel，或另开进程 `/resume` 同一 session 文件。
6. **重复分叉**：同 session 可多次 `/fork-panel`，每次独立占位节点（label `fork-panel`）。

## 机制与风险（重要）

双进程写同一个 session 文件是**受控模式**，pi 本身不支持并发写：

- session 文件为 v3 append-only JSONL；本扩展只依赖纯追加路径（message/custom/label/compaction），不做全文件重写。
- refresh 前做安全检查：文件版本与当前 pi 不一致（migration 会全文件重写，可能破坏 panel 分支）或出现重复 entry id 时**跳过刷新并警告**，不破坏现状。
- 已知残余风险：pi 升级 session 格式、或两个进程恰好生成相同 entry id（概率极低）。根治方案是 pi 本体提供 `SessionManager.reload()` API（暂不提 issue，接受现状）。

## Spike 验证结论

- `herdr agent start pi --pane <id> -- <pi args>`：pane 就绪后可被 agent start 识别（`interactive_ready: true`）；`--` 后直接传 pi 参数（`--session`/`--name`/`--model`），**不要**再写 `pi` 可执行名。
- **split 出的 pane 需要等 shell 就绪**：split 后 pty 初始化有短暂延迟，立即 agent start 会报 `agent_pane_busy`；本扩展会轮询 `pane process-info` 等待前台进程变为 shell（≤15s）。
- **agent name 有格式与唯一性约束**：小写字母开头、1-32 字符（`agent_name_taken` / `invalid_agent_name` 错误）；本扩展用 `slug-随机hex` 保证唯一，可读名称由 pane label 与 pi `--name`（terminal title）提供。
- `herdr agent prompt <target> <text>`：提交的 prompt 走用户消息通道（`/skill:` 等可在 panel 内展开）；fire-and-forget = 不带 `--wait`（`--timeout` 必须配 `--wait`）。
- `herdr pane layout --pane <id>`：返回 pane 的 `rect`（x/y/width/height），用于"最右侧 pane"判定（`--current` 是焦点 pane，不可靠）。

## 手动命令（agent 启动失败时）

```
herdr agent start "Fork: <prompt 摘要>" --kind pi --pane <PANE_ID> -- --session <SESSION_FILE> --name "Fork: <prompt 摘要>"
herdr agent prompt <PANE_ID> "<prompt>"
```

## 文件结构

```
extensions/fork-panel/
├── README.md       ← 本文件
├── index.ts        ← 命令、refresh、双向拦截、占位节点渲染、agent 启动
├── core.ts         ← 纯函数核心（参数解析、split 规划、拦截判定、安全检查）
├── config.ts       ← 模型解析（forkPanel.defaultModel）
└── *.test.ts       ← vitest（core + refresh 集成测试）
```

角色判定（旧 session vs panel）不需要环境变量：从当前 leaf 向上找第一个 `fork-panel` 占位节点，找到 = panel 角色，找不到 = 旧 session 角色。
