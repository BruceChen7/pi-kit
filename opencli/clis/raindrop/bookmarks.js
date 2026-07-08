import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  TimeoutError,
} from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

cli({
  site: "raindrop",
  name: "bookmarks",
  description: "获取 Raindrop.io 收藏列表（bookmarks）",
  access: "read",
  example: "opencli raindrop bookmarks --limit 10 -f json",
  domain: "app.raindrop.io",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      help: "最大返回条数（上限 50）",
      default: "50",
    },
  ],
  columns: ["title", "link", "domain", "created", "tags", "excerpt"],
  func: async (page, kwargs) => {
    // ── 参数解析 ──────────────────────────────────────────────────
    const rawLimit = Number(kwargs.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, 50))
      : 50;
    const url = "https://app.raindrop.io/my/0";

    // ── 1. 打开 Raindrop 页面，建立 cookie session ───────────────
    try {
      await page.goto(url);
    } catch (err) {
      throw new TimeoutError(
        `Failed to load ${url}`,
        30,
        `Navigation timed out: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 等待 SPA 加载完成（Raindrop 使用 #react 作为 root）
    try {
      await page.wait({ selector: "#react", timeout: 30 });
    } catch (_err) {
      throw new TimeoutError(
        `Page ${url} did not finish loading`,
        30,
        "Root element (#react) not found within 30s",
      );
    }

    // 额外等待确保 SPA 完全初始化
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // ── 2. 通过浏览器上下文调用 Raindrop API ────────────────────
    let data;
    try {
      data = await page.evaluate((maxItems) => {
        return fetch(
          `https://api.raindrop.io/v1/raindrops/0?sort=-created&perpage=${maxItems}`,
          { credentials: "include" },
        )
          .then((r) => {
            if (!r.ok) {
              return r
                .text()
                .then((text) =>
                  Promise.reject(
                    new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`),
                  ),
                );
            }
            return r.json();
          })
          .then((d) => ({
            items: (d.items || []).map((item) => ({
              title: item.title || "",
              link: item.link || "",
              domain: item.domain || "",
              created: item.created || "",
              tags: item.tags || [],
              excerpt: (item.excerpt || "").slice(0, 200),
            })),
            total: d.count || 0,
          }));
      }, limit);
    } catch (err) {
      throw new CommandExecutionError(
        "Failed to fetch bookmarks from Raindrop API",
        `API call error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!data || !Array.isArray(data.items)) {
      throw new AuthRequiredError(
        "app.raindrop.io",
        "No data returned — you may need to log in to Raindrop first",
      );
    }

    if (data.items.length === 0) {
      throw new EmptyResultError(
        "opencli raindrop bookmarks",
        "No bookmarks found. Your collection may be empty.",
      );
    }

    return data.items;
  },
});
