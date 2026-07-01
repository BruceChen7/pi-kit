---
description: 随机出 LeetCode 题目（支持难度/标签筛选），展示标题、描述、代码模板、链接
argument-hint: "[count] [--tag <slug>] [--difficulty easy|medium|hard|all] [--lang go|rust|python]"
---
从力扣（LeetCode.cn）随机抽取题目，展示完整信息用于刷题。

## 用法

```bash
opencli leetcode random --count <N> [--tag <slug>] [--include-hard] -f json
opencli leetcode problem --slug <slug> --lang <lang> -f json
```

参数说明：
- `--count`：抽取数量，默认 1
- `--difficulty easy|medium|hard|all`：难度筛选，不指定时 = easy + medium
- `--tag <slug>`：标签筛选（支持英文 slug 如 `array`, `stack`, `dynamic-programming`）
- `--include-hard`：包含 hard 题（等价于 `--difficulty all`）
- `--lang <lang>`：代码模板语言，不指定时默认同时查 go + rust

第一个数字参数自动解析为 count。

## 实现步骤

### Step 1: 随机抽取题目

```bash
opencli leetcode random --count <N> -f json
```

根据用户参数拼接：
- `--include-hard` 或 `--difficulty all` → 不加 `--include-hard` 让 random 默认 easy+medium，加则传递
  - `--difficulty easy`、`medium`、`hard`：random 本身不支持按单一难度过滤，需在结果中二次过滤（见 Step 1a）
- `--tag <slug>` → 追加 `--tag <slug>`
- `--count N` → 追加 `--count N`

返回值示例：
```json
[
  { "id": "1", "title": "两数之和", "difficulty": "EASY",
    "acRate": 0.55, "topicTags": "数组, 哈希表", "slug": "two-sum" },
  ...
]
```

### Step 1a: 处理 random 不直接支持的 --difficulty 值

`opencli leetcode random` 只支持 `--include-hard`（二选：easy+medium / all）。
如果用户指定了单难度（如 `--difficulty easy`），在 random 返回后，用 `jq` 二次过滤：

```bash
opencli leetcode random --include-hard --count 150 -f json | \
  jq '[.[] | select(.difficulty == "EASY")] | .[:<N>]'
```

单难度时拉大池（`--count 150 --include-hard`）再过滤，避免候选池不足。

### Step 2: 获取详情 + 代码模板

对每道题的 slug：

```bash
# 无 --lang 时：分别查 go 和 rust
opencli leetcode problem --slug "<slug>" --lang golang -f json
opencli leetcode problem --slug "<slug>" --lang rust -f json

# 指定 --lang 时：
opencli leetcode problem --slug "<slug>" --lang <lang> -f json
```

`problem` 的 JSON 输出包含：
- `id`, `title`, `difficulty`, `acRate`, `topicTags`, `codeTemplate`
- **`description`**：纯文本中文题目描述（无需额外 curl 或 HTML 清理）

### Step 3: 组装 Markdown 输出

## 输出格式

```markdown
# 🎯 今日随机出题

## <题号>. <标题> — <Difficulty>
- 标签：<topicTags>
- 通过率：<acRate>（转百分比）
- 题目链接：https://leetcode.cn/problems/<slug>/

### 题目描述
<description 字段内容>

### 代码模板

<details>
<summary>Go</summary>

```go
<go 模板代码>
```
</details>

<details>
<summary>Rust</summary>

```rust
<rust 模板代码>
```
</details>
```

- 多道题（`--count N` > 1）按顺序列出每道题的完整信息
- description 已为纯文本，直接使用，无需额外清理
- 代码模板用 code block 包裹，标注语言
- 如果某一语言模板获取失败，标注 `（无模板）`

## 备注

- `opencli leetcode random --count` 最多返回 1500 道，如果 `--difficulty easy` 二次过滤后仍无结果，告知用户无匹配
- 默认语言 Go + Rust（用户偏好），除非 `--lang` 覆盖
- 不要输出原始 JSON 给用户看，除非用户要求
- 如果 `opencli leetcode` 命令失效，给出安装指引
