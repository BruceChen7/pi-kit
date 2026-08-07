# cc-switch — Provider Proxy for Pi

通过 [AIS Switch (cc_switch)](https://ccswitch.io) 的本地代理，将已配置的 provider 模型注册为 Pi 的可用模型。

## 工作原理

```
Pi  ←→  127.0.0.1:15721 (cc_switch 本地代理)  ←→  Upstream Provider
         configured API key / sentinel               (代理处理认证)
```

1. 插件启动时读取 Codex 的模型目录 `~/.codex/ais-switch-model-catalog.json`（由 cc_switch 自动生成）
2. 通过 `pi.registerProvider()` 将代理后的 provider 注册到 Pi

## 前提条件

- AIS Switch (cc_switch) 桌面应用正在运行
- cc_switch 设置中开启了本地代理（`enableLocalProxy: true`）
- cc_switch 中已配置了至少一个 provider，并生成了 Codex model catalog

## 注册的模型

插件从 `ais-switch-model-catalog.json` 动态读取所有模型，因此取决于你在 cc_switch 中配了哪些 provider。所有模型都会保留原有的 slug 命名。

### Thinking levels

每个模型可选的 think level 由 catalog 中的 `supported_reasoning_levels` 决定，与 pi 的级别取交集；catalog 未列出的级别在 pi 中不可选（`xhigh`/`max` 需要 catalog 显式声明）。catalog 中的 `default_reasoning_level` 不会映射——pi 没有 per-model 默认级别，如需固定默认，可在 settings.json 中用 `"model": "cc-switch-gateway/<slug>:<level>"` 指定。

## 使用

安装后重启 Pi，在 model selector 中即可看到 `cc_switch Proxy` provider 下的模型。

### 斜杠命令

- `/cc-switch` — 显示当前代理地址、provider 名称和 catalog 模型数量
- `/cc-switch refresh` — 重新读取模型目录并重新注册（cc_switch 更新 provider 后使用，无需重启 Pi）

首次安装仍需要重启 Pi 让扩展加载并完成初始注册。

## 配置

插件默认使用：
- 代理地址：`http://127.0.0.1:15721`
- API Key：`PROXY_MANAGED`（cc_switch 代理识别此值并注入真实认证）
- API 协议：`openai-responses`

如需自定义，修改 `extensions/cc-switch/index.ts` 顶部的常量。

## 代码结构

- `core.ts` — 纯转换逻辑（Codex catalog → pi model），无 IO，可独立测试
- `index.ts` — 命令式外壳：读取 catalog、注册 provider、斜杠命令

## 调试日志

日志 tag 为 `cc-switch`，通过 `third_extension_settings.json` 的 `log` 字段配置级别。
