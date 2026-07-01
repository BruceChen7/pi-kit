import { CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

const GRAPHQL_URL = "https://leetcode.cn/graphql";

/**
 * LeetCode GraphQL query: problem list
 */
const PROBLEMS_LIST_QUERY = `query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList(categorySlug: $categorySlug, limit: $limit, skip: $skip, filters: $filters) {
    total
    questions {
      acRate
      difficulty
      frontendQuestionId
      paidOnly
      solutionNum
      title
      titleCn
      titleSlug
      topicTags {
        slug
        name
        nameTranslated
      }
    }
  }
}`;

/**
 * Map user-facing sort key → GraphQL enum
 */
const SORT_FIELDS = {
  id: "FRONTEND_ID",
  acRate: "AC_RATE",
  submissions: "SOLUTION_NUM",
};

cli({
  site: "leetcode",
  name: "problems",
  description:
    "拉取力扣题目列表（默认 easy + medium，支持 --include-hard 扩展到 hard）",
  access: "read",
  example: [
    "opencli leetcode problems",
    "opencli leetcode problems --limit 50",
    "opencli leetcode problems --include-hard",
    "opencli leetcode problems --sort acRate",
    "opencli leetcode problems --sort submissions --limit 100",
  ].join("\n"),
  domain: "leetcode.cn",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "limit",
      help: "返回题目数量上限（默认 200）",
      default: 200,
    },
    {
      name: "include-hard",
      help: "包含困难题（默认只返回简单 + 中等）",
      boolean: true,
      default: false,
    },
    {
      name: "sort",
      help: "排序字段：id（默认，升序）、acRate（降序）、submissions（降序）",
      default: "id",
    },
  ],
  columns: [
    "id",
    "title",
    "difficulty",
    "acRate",
    "topicTags",
    "solutionNum",
    "slug",
  ],
  func: async (kwargs) => {
    const limit = Math.min(Math.max(1, Number(kwargs.limit) || 200), 2000);
    const sortBy = SORT_FIELDS[kwargs.sort] || "FRONTEND_ID";
    const sortOrder = kwargs.sort === "id" ? "ASCENDING" : "DESCENDING";

    // Build filters
    const filters = {
      orderBy: sortBy,
      sortOrder,
    };

    let raw;
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: PROBLEMS_LIST_QUERY,
          variables: {
            categorySlug: "",
            limit,
            skip: 0,
            filters,
          },
        }),
      });
      raw = await res.json();
    } catch (err) {
      throw new CommandExecutionError(
        "Failed to fetch problem list",
        `GraphQL request failed: ${err.message}`,
      );
    }

    const data = raw?.data?.problemsetQuestionList;
    if (!data?.questions) {
      throw new CommandExecutionError(
        "Failed to fetch problem list",
        `GraphQL response: ${JSON.stringify(raw?.errors ?? raw)}`,
      );
    }

    let questions = data.questions;

    // Filter out HARD unless --include-hard (opencli converts default to string)
    if (String(kwargs["include-hard"]) !== "true") {
      questions = questions.filter(
        (q) => q.difficulty === "EASY" || q.difficulty === "MEDIUM",
      );
    }

    return questions.map((q) => ({
      id: q.frontendQuestionId,
      title: q.titleCn || q.title,
      difficulty: q.difficulty,
      acRate: q.acRate,
      topicTags: (q.topicTags || [])
        .map((t) => t.nameTranslated || t.name)
        .join(", "),
      solutionNum: q.solutionNum ?? 0,
      slug: q.titleSlug,
    }));
  },
});
