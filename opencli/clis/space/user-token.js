import { writeFile } from "node:fs/promises";
import {
  AuthRequiredError,
  CommandExecutionError,
  TimeoutError,
} from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";

cli({
  site: "space",
  name: "user-token",
  description: "从 space.shopee.io 获取当前用户的 JWT token",
  access: "read",
  example:
    "opencli space user-token\nopencli space user-token --write ~/.space/token",
  domain: "space.shopee.io",
  strategy: Strategy.UI,
  browser: true,
  args: [
    {
      name: "write",
      help: "将 token 写入指定文件路径",
    },
  ],
  columns: ["token"],
  func: async (page, kwargs) => {
    const url = "https://space.shopee.io/";

    // 打开 SPACE 页面
    try {
      await page.goto(url);
    } catch (err) {
      throw new TimeoutError(
        `Failed to load ${url}`,
        `Navigation timed out: ${err.message}`,
      );
    }

    // 等待页面加载完成（核心 SPA 渲染）
    try {
      await page.wait({ selector: "#root", timeout: 30 });
    } catch (_err) {
      throw new TimeoutError(
        `Page ${url} did not finish loading`,
        "Root element not found within 30s",
      );
    }

    // 额外等待确保 SPA 完全初始化
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 从 localStorage 读取 session 数据
    let sessionData;
    try {
      sessionData = await page.evaluate(() => {
        try {
          const raw = localStorage.getItem("session");
          if (!raw) return null;
          return JSON.parse(raw);
        } catch {
          return null;
        }
      });
    } catch (err) {
      throw new CommandExecutionError(
        "Failed to read localStorage",
        `evaluate error: ${err.message}`,
      );
    }

    if (!sessionData?.token) {
      throw new AuthRequiredError(
        "No user token found in localStorage",
        "Please log in to space.shopee.io first and ensure you are on the page",
      );
    }

    const token = sessionData.token;

    // 如果指定了 --write 参数，写入文件
    if (kwargs.write) {
      try {
        await writeFile(kwargs.write, token, "utf-8");
      } catch (err) {
        throw new CommandExecutionError(
          `Failed to write token to ${kwargs.write}`,
          `write error: ${err.message}`,
        );
      }
    }

    // 返回 token（opencli 会自动将 columns 字段输出到 stdout）
    // 当 -f plain 时只输出 token 字段值
    return [{ token }];
  },
});
