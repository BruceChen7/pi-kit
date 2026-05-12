# codex-plan-limits (pi-kit)

这个扩展用于在 Pi 中显示 **OpenAI Codex 订阅额度**，并且**不覆盖默认 footer/context token**。

## 功能

当前模型满足以下条件时：

- provider: `openai-codex`
- 鉴权方式：OAuth（订阅登录）

扩展会在编辑器下方以**灰色单独一行**显示订阅信息（widget）：

- 5h 窗口剩余额度
- Weekly 窗口剩余额度
- 两个窗口的重置时间

当不满足条件（例如切到其他 provider）时，会自动清理这条订阅信息。

## 刷新策略

额度信息会在以下时机更新：

- session start
- model select
- turn end
- 每 60 秒轮询

实时拉取失败时会回退到缓存快照。

## 在 pi-kit 中启用

本仓库已在 `package.json` 的 `pi.extensions` 中注册：

- `./extensions/codex-plan-limits`

## 致谢

本实现基于并致谢：

- [kmiyh/pi-codex-plan-limits](https://github.com/Kmiyh/pi-codex-plan-limits)

感谢原项目提供的思路与实现基础。
