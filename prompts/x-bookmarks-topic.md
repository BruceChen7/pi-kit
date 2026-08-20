---
description: 检索我在 X 收藏中与某个 topic 相关的全部帖子(全量覆盖、去重、分类、可点击链接)
argument-hint: "<topic> [related-terms...] [--recent N] [--strict] [--refresh]"
---
按主题检索我收藏的 X 帖子,并输出**可点击链接**列表。这是"深度主题检索":默认扫描**全部收藏**(自动翻页),而不是只看最近几条;适合回答"我收藏过哪些 sqlite / rust / agent 相关帖子"这类问题。

使用 `opencli` 的 X/Twitter 适配器(bookmarks,COOKIE 策略,复用我的登录态)。

## 参数解析

- 第一个非 `--` 参数 = **主题词** `<topic>`(必填)
- 之后的非 `--` 参数 = **相关词**(可选,用于扩展匹配,见下)
- 支持的选项:
  - `--recent N`:只扫最近 N 条(快速路径,不翻页);默认全量
  - `--strict`:只保留"核心命中"(过滤掉"顺带提及")
  - `--refresh`:忽略本会话缓存,强制重新拉取

## 命令与拉取策略

1. 先运行 `opencli twitter whoami -f plain` 预检登录;未登录时明确告知,并提示运行 `opencli twitter login` 后重试,不继续。
2. 拉取缓存:
   - 本会话内已生成缓存文件 `/tmp/x-bookmarks-<日期>.json` 且未指定 `--refresh` → **直接复用**,跳过拉取
   - 否则运行:
     - 全量:`OPENCLI_BROWSER_COMMAND_TIMEOUT=600 opencli twitter bookmarks --limit 10000 -f json` 输出到 `/tmp/x-bookmarks-<日期>.json`(翻页到 API 上限,通常 10k 内;首次可能耗时数分钟,属正常)
     - `--recent N`:`opencli twitter bookmarks --limit N -f json`(不翻页,快)
   - 把缓存路径告诉用户,并说明后续主题查询会复用同一份数据。

## 过滤与组织(核心步骤)

3. **过滤**:用主词 + 相关词对每条 tweet 文本做不区分大小写的匹配。若相关词外的同义/近义衍生词明显相关(sqlite ∪ turso/litestream/sqlcipher/wcdb 这类),可额外补扫并标注为"扩展命中"。常见扩展示例:
   - sqlite → turso, libsql, litestream, sqlcipher, wcdb, sqlite3
   - ai agent → claude code, mcp, openclaw, agent framework, skills
   - 保存优化 → 缓存,索引,分页,wal,fts
   不要过度扩展成"顺带提一词就全收"——拿不准时靠摘要判断。
4. **去重**:按 tweet id 去重,重复书签显式标注"重复"或只保留一次并在旁注明。
5. **分类**(判断每条归属,给出小标题):
   - **核心主题**:帖子本身在讲这个 topic(技术、工具、库、方案)
   - **用到该主题**:这是一个项目/产品,但 topic 只是其存储/实现细节
   - **顺带提及**:topic 只是背景或举例(`--strict` 时丢弃)
6. 组内按时间倒序。

## 输出格式(中文注释)

直接列出结果,**每条帖子的 URL 必须独立成行**(Pi 的 Markdown 表格里链接不可点,纯 URL 成行才可点击)。不要输出原始 JSON。

结构:

# X 收藏检索:<主题>
- 覆盖范围:全部收藏 <N> 条 / 最近 N 条,检索日期
- 命中:共 M 条(字面命中 X 条 + 扩展命中 Y 条,已去重)
- 缓存:复用 `/tmp/x-bookmarks-<日期>.json` 或"本次已新建"

分组输出(按上面分类):

## 🎯 核心主题
1. **<短标题/摘要>** — @作者,<时间>,<👍/♻️ 数据>
   https://x.com/<handle>/status/<id>

## 🧰 用到该主题(工具/项目)
(同上格式)

## ♻️ 顺带提及
(同上格式,`--strict` 时去掉本组)

> 注:如遇推文只有链接/转发式短文本,如实说明;命中数少(≤3)时可直接平铺不分组。

## 失败兜底

- 超时/翻页失败:提示提高 `OPENCLI_BROWSER_COMMAND_TIMEOUT` 重试;不要静默降级成局部结果
- 持续性失败:建议 `--trace retain-on-failure` 复查
- 结果为空:先核对关键词与相关词是否需要扩展,告知"收藏中未命中",并给出建议的相关词

## Notes

- 只搜书签(bookmarks);用户提到"喜欢/赞/likes"时另行告知当前模板不支持
- 不同时下载媒体或抓取全文
- 二次查询不同主题时复用缓存,别重新翻页

User-provided arguments: $@
