# LeetCode.cn Site Memory

## 2026-07-01 by pi (opencli-adapter-author)

Created adapters: `leetcode/problems` and `leetcode/problem`

### Key findings
- GraphQL endpoint: `https://leetcode.cn/graphql` (POST)
- Auth: COOKIE strategy — Chrome browser bridge provides login session
- No anti-bot detected; GraphQL works directly via `fetch` inside `page.evaluate`
- Problem list: `query problemsetQuestionList(...)` returns fields:
  - `total`, `questions[{ frontendQuestionId, titleCn, difficulty, acRate, solutionNum, topicTags, titleSlug }]`
- Problem detail: `query questionDetail($titleSlug: String!)` returns:
  - `translatedTitle`, `translatedContent` (HTML), `difficulty`, `acRate`, `stats` (JSON string), `codeSnippets`, `similarQuestions` (JSON string)
- Sort support: `filters: { orderBy: FRONTEND_ID | AC_RATE | SOLUTION_NUM, sortOrder: ASCENDING | DESCENDING }`
- Difficulty filter: `filters: { difficulty: EASY | MEDIUM | HARD }` (single value only, not array)

### Adapter commands
- `opencli leetcode problems` — list problems (default easy+medium, --include-hard, --sort, --limit)
- `opencli leetcode problem --slug <slug>` — single problem detail

## 2026-07-01 by pi (改为 PUBLIC + browser: false)

- 将 `leetcode/problems` 和 `leetcode/problem` 从 COOKIE + browser: true 改为 PUBLIC + browser: false
- 不再需要 Chrome 浏览器，直接用 Node.js fetch 调 GraphQL 公开接口
- 速度快很多，零 CDP 开销
- 损失字段：`status`（用户是否已 AC）—— 默认不输出，不影响列表和详情功能
