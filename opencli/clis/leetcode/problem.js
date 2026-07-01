import {
  ArgumentError,
  CommandExecutionError,
} from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

const GRAPHQL_URL = "https://leetcode.cn/graphql";

/**
 * LeetCode GraphQL query: single question detail (description, code snippets, similar questions)
 */
const PROBLEM_DETAIL_QUERY = `query questionDetail($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionFrontendId
    translatedTitle
    translatedContent
    difficulty
    acRate
    stats
    topicTags {
      slug
      name
    }
    codeSnippets {
      lang
      langSlug
      code
    }
    similarQuestions
  }
}`;

cli({
  site: "leetcode",
  name: "problem",
  description: "查看力扣单题详情（描述、代码模板、相似题目）",
  access: "read",
  example: [
    "opencli leetcode problem --slug two-sum",
    'opencli leetcode problem --slug "longest-substring-without-repeating-characters"',
    "opencli leetcode problem --slug two-sum --lang python",
    "opencli leetcode problem --slug two-sum --lang golang -f json",
  ].join("\n"),
  domain: "leetcode.cn",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    {
      name: "slug",
      help: "题目的 titleSlug（URL 中的路径，如 two-sum）",
      required: true,
    },
    {
      name: "lang",
      help: "筛选代码模板的语言（如 python、golang、rust、java、cpp），不指定则列出所有可用语言",
      default: "",
    },
  ],
  columns: [
    "id",
    "title",
    "difficulty",
    "acRate",
    "accepted",
    "submitted",
    "topicTags",
    "codeTemplate",
    "description",
  ],
  func: async (kwargs) => {
    const slug = String(kwargs.slug || "").trim();
    if (!slug) {
      throw new ArgumentError(
        "Missing required argument: slug",
        "Usage: opencli leetcode problem --slug <slug>",
      );
    }

    let raw;
    try {
      const res = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: PROBLEM_DETAIL_QUERY,
          variables: { titleSlug: slug },
        }),
      });
      raw = await res.json();
    } catch (err) {
      throw new CommandExecutionError(
        "LeetCode GraphQL request failed",
        `question(${slug}): ${err.message}`,
      );
    }

    const q = raw?.data?.question;
    if (!q) {
      throw new CommandExecutionError(
        `Problem not found: ${slug}`,
        `GraphQL response: ${JSON.stringify(raw?.errors ?? raw)}`,
      );
    }

    // Parse stats JSON
    let stats = { totalAccepted: "N/A", totalSubmission: "N/A" };
    if (q.stats) {
      try {
        stats = JSON.parse(q.stats);
      } catch {
        // ignore parse errors
      }
    }

    // Find matching code template
    let codeTemplate = "";
    const langFilter = String(kwargs.lang || "")
      .trim()
      .toLowerCase();
    if (langFilter) {
      // Filter by specific language
      const matched = (q.codeSnippets || []).find(
        (s) =>
          s.langSlug?.toLowerCase() === langFilter ||
          s.lang?.toLowerCase() === langFilter,
      );
      codeTemplate = matched?.code ?? `(no template for: ${langFilter})`;
    } else if (q.codeSnippets?.length) {
      // List all available languages
      codeTemplate = q.codeSnippets.map((s) => s.lang).join(", ");
    }

    // Build plain-text description from translatedContent
    const description = (q.translatedContent || "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&sup\d;/g, (m) => ({ sup2: "²", sup3: "³" })[m] || m)
      .replace(/&(\w+);/g, (m) => m)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");

    return [
      {
        id: q.questionFrontendId,
        title: q.translatedTitle,
        difficulty: q.difficulty,
        acRate: q.acRate,
        accepted: stats.totalAccepted || "N/A",
        submitted: stats.totalSubmission || "N/A",
        topicTags: (q.topicTags || []).map((t) => t.name).join(", "),
        codeTemplate,
        description,
      },
    ];
  },
});
