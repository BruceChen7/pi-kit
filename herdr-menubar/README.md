# herdr-menubar

Herdr agent 状态系统菜单栏(glimpse `statusItem()`),按方案实现。

## 运行

```bash
cd ~/work/pi-kit/herdr-menubar
npm start                 # 手动启动(依赖 pi-kit/node_modules/glimpseui)
npm run install:launch-agent   # 开机自启(LaunchAgent);--uninstall 卸载
```

菜单栏图标:`● N`(绿点 + working 数)/ `○` 全空闲 / `✕` herdr 离线(自动重连)。

## 交互

- 点击图标 → popover:按 workspace 分组列出所有 agent(状态色点 + 标题 + 状态标签 + 完成后最后一条消息)
- 顶部 chips 按状态筛选(all / working / idle / blocked / done / unknown)
- 点击 agent 行 → herdr 切到该 workspace 并聚焦该 agent 的 pane,并激活其终端 app(Ghostty)
- 点击消息摘要 → 展开/收起全文;popover 高度随行数自适应
- 底部"退出" → 关闭

## 架构

```
src/menubar.mjs       薄壳:连接 / 订阅 / IO(pane.read、focus)/ 渲染编排
src/agent-store.mjs   纯逻辑层:initFromSnapshot / applyEvent / viewData / summarize(可单测)
src/herdr-client.mjs  herdr Unix socket JSON Lines 客户端(request / subscribe)
src/socket-detect.mjs 多实例 socket 探测:HERDR_SOCKET_PATH → ~/.config/herdr/herdr.sock → sessions/*/herdr.sock
src/view.mjs          popover HTML + __render / __toggleExpand / 状态筛选
test/agent-store.test.mjs   node --test
```

数据流:`session.snapshot` 初始化 → `events.subscribe` 推送(`pane.agent_status_changed`
等)→ agent-store 纯函数更新 → transitions 中 working→idle/done 触发 `pane.read`
读最后一条消息 → `setTitle` + `win.send(js)` 增量渲染。30s 对账防事件漂移;
订阅断开 3s 重连;多 herdr 实例(source 前缀隔离)合并展示。

## 菜单栏图标(原生补丁)

glimpse 原版 statusItem 只支持文本 title。`native/glimpse.swift` 是上游
`node_modules/glimpseui/src/glimpse.swift` 的副本 + 补丁,新增 `icon` 协议命令:

```json
{"type":"icon","symbol":"circle.fill","color":"#4ADE80"}
{"type":"icon","image":"<base64 png>"}
```

构建并装入 node_modules(glimpseui 按默认路径找二进制,平台检测才正确):

```bash
npm run build:native     # swiftc -O → bin/glimpse → 覆盖 ../node_modules/glimpseui/src/glimpse
```

注意:`npm install` 重装 glimpseui 会覆盖二进制,重跑 `build:native` 即可;
补丁源码即 `native/glimpse.swift`(上游副本 + icon 命令扩展)。

## 测试

```bash
npm test    # 9 个用例:状态机 / transitions / 多实例隔离 / 分组排序 / 摘要
```
