import { CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

const GRAPHQL_URL = "https://leetcode.cn/graphql";

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

cli({
  site: "leetcode",
  name: "random",
  description:
    "随机一道力扣题目（默认 easy + medium，支持 --include-hard 和 --tag 筛选）",
  access: "read",
  example: [
    "opencli leetcode random",
    "opencli leetcode random --include-hard",
    "opencli leetcode random --tag stack",
    "opencli leetcode random --tag dynamic-programming --include-hard",
    "opencli leetcode random --count 3",
    "opencli leetcode random --count 3 --include-hard --tag array -f json",
  ].join("\n"),
  domain: "leetcode.cn",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "include-hard",
      help: "包含困难题（默认只从简单 + 中等中随机）",
      boolean: true,
      default: false,
    },
    {
      name: "tag",
      help: "按标签筛选（slug 格式，如 stack、dynamic-programming、array）",
      default: "",
    },
    {
      name: "count",
      help: "返回题目数量（默认 1）",
      default: 1,
    },
  ],
  columns: ["id", "title", "difficulty", "acRate", "topicTags", "slug"],
  func: async (kwargs) => {
    // opencli converts default:false to string "false", so compare the actual value
    const includeHard = String(kwargs["include-hard"]) === "true";
    const tagSlug = String(kwargs.tag || "")
      .trim()
      .toLowerCase();
    const count = Math.max(1, Number(kwargs.count) || 1);

    // Fetch a large batch to get a good random sample
    const queryLimit = 1500;

    let raw;
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: PROBLEMS_LIST_QUERY,
          variables: {
            categorySlug: "",
            limit: queryLimit,
            skip: 0,
            filters: {
              orderBy: "FRONTEND_ID",
              sortOrder: "ASCENDING",
            },
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

    const questions = raw?.data?.problemsetQuestionList?.questions;
    if (!questions?.length) {
      throw new CommandExecutionError(
        "No problems found",
        `GraphQL response: ${JSON.stringify(raw?.errors ?? raw)}`,
      );
    }

    // Apply filters
    let filtered = questions;
    if (!includeHard) {
      filtered = filtered.filter(
        (q) => q.difficulty === "EASY" || q.difficulty === "MEDIUM",
      );
    }
    if (tagSlug) {
      filtered = filtered.filter((q) =>
        (q.topicTags || []).some(
          (t) =>
            t.slug?.toLowerCase() === tagSlug ||
            t.name?.toLowerCase() === tagSlug,
        ),
      );
    }

    if (!filtered.length) {
      const tagHint = tagSlug ? `tag: ${tagSlug}, ` : "";
      throw new CommandExecutionError(
        "No matching problems found",
        `${tagHint}difficulty: ${includeHard ? "all" : "easy+medium"}, total fetched: ${questions.length}`,
      );
    }

    // Pick N unique at random (Fisher-Yates partial shuffle)
    const pool = [...filtered];
    const n = Math.min(count, pool.length);
    const picks = [];
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
      picks.push(pool[i]);
    }
    // Sort by frontendQuestionId for stable output
    picks.sort(
      (a, b) => Number(a.frontendQuestionId) - Number(b.frontendQuestionId),
    );

    return picks.map((q) => ({
      id: q.frontendQuestionId,
      title: q.titleCn || q.title,
      difficulty: q.difficulty,
      acRate: q.acRate,
      topicTags: (q.topicTags || [])
        .map((t) => t.nameTranslated || t.name)
        .join(", "),
      slug: q.titleSlug,
    }));
  },
});
