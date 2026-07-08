---
description: 查询 my_notes 知识库，直接使用 qmd 工具（qmd_query / qmd_search / qmd_get / qmd_multi_get）
argument-hint: "<查询内容>"
---
# 查询 my_notes

当用户提出关于笔记的任何问题时，**必须直接使用 qmd 工具**，不能先尝试其他方法（如 grep/find/cs_search/rg）再 fallback 到 qmd。

## 工具选择指南

| 意图 | 工具 | 说明 |
|------|------|------|
| 检查集合状态 | `qmd_status` | 第一步，确认 `my_notes` 集合存在 |
| 语义搜索（自然语言） | `qmd_query` | 用自然语言描述要找的内容，适合模糊/概念性搜索 |
| 关键词搜索 | `qmd_search` | 精确关键词，适合已知术语/文件名匹配 |
| 读取单篇笔记 | `qmd_get` | 获取具体文档的完整内容 |
| 批量读取 | `qmd_multi_get` | 按 glob 或列表批量获取多个文档 |

## 查询流程

### 第一步：检查集合
```json
qmd_status()
```
确认 `my_notes` 集合在线、有文档。

### 第二步：选择搜索策略
- **模糊/概念性查询**（如"找关于 eBPF 观测的笔记"）→ 用 `qmd_query(query, {collections: ["my_notes"]})`
- **精确关键词查询**（如"找 malloc 实现的笔记"）→ 用 `qmd_search(query, {collections: ["my_notes"]})`
- **已知路径查询**（如"读 Wiki/Summaries/Notes/malloc的实现-summary.md"）→ 用 `qmd_get` 或 `qmd_multi_get`

### 第三步：阅读文档
- 搜索结果会返回 `docid`（如 `#a1b2c3`）和 `file` 路径
- 用 `qmd_get({file: "qmd://my_notes/path/to/file.md"})` 读取完整内容
- 用 `qmd_get({file: "qmd://my_notes/path/to/file.md", fromLine: 10, maxLines: 50})` 读取部分内容
- 用 `qmd_multi_get({pattern: "qmd://my_notes/Wiki/Summaries/Notes/*-cache*.md"})` 批量读取

### 第四步：组织回答
- 用中文回答（匹配笔记语言）
- 标注来源文件路径
- 如果有多个相关结果，按相关性排序展示
- 如果搜索结果不理想，尝试不同的 query 表述再搜一次

## 参数传递

用户提供的参数通过 `$@` 传入，作为查询内容。

## 边界情况

- **qmd 工具不可用**：如果 `qmd_status` 返回空或无集合，告知用户并建议排查 qmd 是否安装/配置
- **搜索无结果**：尝试换同义词/不同角度再搜一次，仍无结果则如实告知
- **多篇相关笔记**：优先展示 summary 文件（`*-summary.md`），方便用户快速概览
- **有 wiki 索引**：`Wiki/index.md` 是整个笔记库的索引入口，可先读取了解整体结构

## 注意事项

- ✅ 始终用 `{collections: ["my_notes"]}` 限定集合
- ✅ `qmd_query` 适合自然语言语义搜索，是首选入口
- ✅ `qmd_search` 适合精确关键词匹配
- ✅ `qmd_get` 参数用 `file` 字段，值为 `qmd://my_notes/...` 格式
- ❌ 不要先试 grep/find/rg/cs_search 再 fallback 到 qmd——直接上 qmd
- ❌ 不要用复杂 shell 命令操作笔记文件，qmd 工具链已经覆盖

## 常用 qmd 命令参考

```bash
# 语义搜索
qmd query "关于 eBPF 的笔记" -c my_notes

# 关键词搜索
qmd search "malloc 实现" -c my_notes

# 读取文档
qmd get qmd://my_notes/Notes/笔记方法.md

# 批量读取
qmd get qmd://my_notes/Wiki/Summaries/Notes/redis*.md

# 列出集合文件
qmd ls my_notes
```

User-provided query: $@
