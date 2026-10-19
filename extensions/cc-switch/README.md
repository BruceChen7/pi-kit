# cc-switch — Provider Proxy for Pi

通过 [AIS Switch (cc_switch)](https://ccswitch.io) 的本地代理，将已配置的 provider 模型注册为 Pi 的可用模型。

## 工作原理

```
Pi  ←→  127.0.0.1:15721 (cc_switch 本地代理)  ←→  Upstream Provider
         configured API key / sentinel               (代理处理认证)
```

1. 插件启动时从本地代理的 `/v1/models` 获取实时模型列表
2. 从 Codex 模型目录 `~/.codex/ais-switch-model-catalog.json`（cc_switch 自动生成）读取每个模型的元数据：thinking level、context window、input modalities
3. 将两者转换为 Pi provider model 配置（代理的实时字段优先，catalog 补齐缺失项）
4. 通过 `pi.registerProvider()` 注册到 Pi

## 前提条件

- AIS Switch (cc_switch) 桌面应用正在运行
- cc_switch 设置中开启了本地代理（`enableLocalProxy: true`）
- cc_switch 中已配置至少一个 provider，并且 `/v1/models` 能返回模型
- 需要 thinking level 时：cc_switch 已生成 Codex model catalog

## 注册的模型

插件从代理的 `/v1/models` 读取模型，因此注册结果取决于 cc_switch 当前配置的 provider。

### 模型元数据

代理接口不提供模型能力元数据，因此 reasoning level、context window、input modalities 都来自 cc_switch 自己生成的 Codex model catalog（`~/.codex/ais-switch-model-catalog.json`），按模型 slug 匹配：

- 优先级：代理 `/v1/models` 里带了的字段优先，catalog 补上代理没给的（当前代理只回 id 和路由信息，所以实际上都来自 catalog）；catalog 也没收录的模型回退为「非 reasoning + 1M context + 纯文本」
- `context_window` / `max_context_window` 直接作为 Pi 的 `contextWindow`（`effective_context_window_percent` 不参与，Pi 自己管 compact 余量）
- `input_modalities` 含 `image` 时模型才允许图片输入

### Thinking levels

- catalog 中 `supported_reasoning_levels` 声明过的级别才会出现在 `/thinking` 里（`xhigh`/`max` 必须显式声明）；未声明的级别 Pi 视为不支持，不会向上游发送可能被拒的 effort
- catalog 未收录的模型保持非 reasoning —— 不猜测上游能力
- `off` 只在 catalog 声明了 `none` 时可选（映射为显式的「不推理」）；否则 Pi 隐藏 `off`：省略 reasoning 字段会落到上游默认值（某些网关默认 `max`），那并不等于关闭思考
- catalog 里的 `ultra` 等 Pi 没有的级别会被忽略
- catalog 中的 `default_reasoning_level` 不映射——Pi 没有 per-model 默认级别，如需固定默认可在 settings.json 中用 `"model": "cc-switch-gateway/<slug>:<level>"` 指定

## 使用

安装后重启 Pi，在 model selector 中即可看到 `cc_switch Proxy` provider 下的模型。

### 斜杠命令

- `/cc-switch` — 显示当前代理地址、provider 名称、模型数量以及有多少模型带 thinking level
- `/cc-switch refresh` — 重新请求代理模型列表 + 重读 model catalog 并重新注册（cc_switch 更新 provider 后使用，无需重启 Pi）

首次安装仍需要重启 Pi 让扩展加载并完成初始注册。

## 配置

插件默认使用：

- 代理地址：`http://127.0.0.1:15721`
- API Key：`PROXY_MANAGED`（cc_switch 代理识别此值并注入真实认证）
- API 协议：`openai-responses`

如需自定义，修改 `extensions/cc-switch/index.ts` 顶部的常量。

## 代码结构

- `core.ts` — 纯转换逻辑（proxy model + catalog metadata → Pi model），无 IO，可独立测试
- `index.ts` — 命令式外壳：请求代理模型列表、读取 model catalog、注册 provider、斜杠命令

## 调试日志

日志 tag 为 `cc-switch`，通过 `third_extension_settings.json` 的 `log` 字段配置级别。
