## 2026-06-04 by Pi agent

- 新建 `space/user-token` adapter：从 space.shopee.io 的 localStorage['session'].token 读取 JWT token
- 策略: UI (browser: true)
- 支持 `--write <path>` 参数写入文件
- 成功验证通过 opencli browser verify
- 源码位于 pi-kit/opencli/clis/space/user-token.js，symlink 到 ~/.opencli/clis/space/user-token.js
- 需要在 pi-kit/node_modules/@jackwener/opencli 创建 symlink 才能正确 resolve 全局 opencli 依赖

## 2026-06-05 by Pi agent

- 新建 `space/trace` adapter：通过 OpenAPI 获取 trace 完整详情
- API: `POST /openapi/v1/trace/search/trace/detail`
- 环境: live (log.shopee.io) / test (log.test.shopee.io)
- 认证: `x-openapi-key` header
- Token 配置优先级: `--token` 参数 > `~/.space/trace-token` (JSON) > `~/.config/cursor_config_be/.env` > 内置默认 token
- 策略: Strategy.PUBLIC (非浏览器)，直接 HTTP 调用
- 输出: summary (stderr) + span 列表 (stdout, 每行一个 span)
- 参数: --trace-id (必填), --env, --token, --errors-only, --show-detail, --slow-threshold
- 数据来源: `fetch-trace.sh` 脚本中的 OpenAPI 方案，确认可用 (483 spans, 含 RPC req/resp events)
