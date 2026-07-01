# leetcode.cn（力扣）

## 域名

| 用途 | 域名 |
|------|------|
| 主站 | `leetcode.cn` |
| 题目集 | `leetcode.cn/problemset/` |
| GraphQL API | `leetcode.cn/graphql` |
| 静态资源 | `static.leetcode.cn` |

## 默认鉴权

- `Strategy.COOKIE + browser: true`
- 匿名也能调 GraphQL 读接口，但登录后能获取用户状态（`status` 字段：AC/attempted/todo）

## 已知 endpoint

- `POST leetcode.cn/graphql` — 题目列表 `query problemsetQuestionList(...)`：
  - 根字段：`problemsetQuestionList(categorySlug, limit, skip, filters) { total, questions[] }`
  - filters 支持：`orderBy` (FRONTEND_ID / AC_RATE / SOLUTION_NUM)、`sortOrder` (ASCENDING / DESCENDING)、`difficulty` (EASY / MEDIUM / HARD)
  - `QuestionLightNode` 字段：`frontendQuestionId`, `title`, `titleCn`, `difficulty`, `acRate` (0-1), `solutionNum`, `paidOnly`, `topicTags[{slug, name, nameTranslated}]`, `titleSlug`, `status`
  - `difficulty` filter 只接受单值（不支持数组），需要 easy+medium 须 client-side 过滤或分两次查询
- `POST leetcode.cn/graphql` — 单题详情 `query questionDetail($titleSlug: String!)`：
  - 根字段：`question(titleSlug)` 返回 `QuestionNode`
  - 字段：`questionFrontendId`, `translatedTitle`, `translatedContent` (HTML), `difficulty`, `acRate`, `stats` (JSON string), `topicTags[{slug, name}]`, `codeSnippets[{lang, langSlug, code}]`, `similarQuestions` (JSON string)

## 字段

| 字段 | 含义 | 出现位置 |
|------|------|---------|
| `frontendQuestionId` | 题号（页面上看到的数字） | `QuestionLightNode`（列表） |
| `questionFrontendId` | 题号 | `QuestionNode`（详情） |
| `titleCn` / `translatedTitle` | 中文标题 | 列表 / 详情 |
| `titleSlug` | URL slug（如 `two-sum`） | 列表 |
| `acRate` | 通过率（0-1 小数） | 列表 + 详情 |
| `solutionNum` | 题解数 | 列表 |
| `difficulty` | 难度：EASY / MEDIUM / HARD | 列表 + 详情 |
| `translatedContent` | 中文题目描述（HTML） | 详情 |
| `stats` | JSON 字符串：`{totalAccepted, totalSubmission, totalAcceptedRaw, totalSubmissionRaw, acRate}` | 详情 |
| `codeSnippets` | 代码模板数组 `{lang, langSlug, code}` | 详情 |
| `similarQuestions` | JSON 字符串数组：`{title, titleSlug, difficulty, translatedTitle, isPaidOnly}` | 详情 |
| `paidOnly` | 是否 Plus 会员题 | 列表 |

## 坑 / 陷阱

1. **列表和详情的字段名不同**：列表是 `frontendQuestionId`，详情是 `questionFrontendId`；列表叫 `titleCn`，详情叫 `translatedTitle`
2. **`similarQuestions` 和 `stats` 是 JSON 字符串**（不是对象），需要 `JSON.parse()`
3. **`difficulty` filter 不支持数组**：`filters: { difficulty: [EASY, MEDIUM] }` 会报错，必须分两次查或 client-side 过滤
4. **匿名也能查**，但 `status` 字段需要登录才有值
5. **列表支持服务端排序**，通过 `filters.orderBy` 和 `filters.sortOrder`，值都是裸枚举（不加引号）
6. **`problemsetQuestionList` 是根字段名**，不是别名——不要写成 `questionList` 或 `problemList`
7. **`total` 直接可用**（不是 `totalNum`）
8. **默认 skip=0，limit 最大 2000**，超出需分页

## 可参考的 adapter

| 模板类型 | 参考文件 |
|---------|---------|
| 题目列表 | `clis/leetcode/problems.js` |
| 单题详情 | `clis/leetcode/problem.js` |
