import { describe, expect, it } from "vitest";
import { fetchConfluencePage } from "./browser";

const enabled = process.env.RUN_CONFLUENCE_SMOKE === "1";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(
      `Missing required smoke-test environment variable: ${name}`,
    );
  return value;
}

describe.skipIf(!enabled)("internal Confluence REST smoke test", () => {
  it("reads a page through the logged-in SSO browser session", async () => {
    const baseUrl = requiredEnv("ATLASSIAN_CONFLUENCE_BASE_URL");
    const pageId = requiredEnv("CONFLUENCE_SMOKE_PAGE_ID");
    const url = `${baseUrl.replace(/\/+$/, "")}/pages/viewpage.action?pageId=${pageId}`;
    const page = await fetchConfluencePage(url, pageId);
    expect(page).toMatchObject({ id: pageId });
    expect(page.markdown.length).toBeGreaterThan(0);
  });
});
