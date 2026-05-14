import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCacheGraphHtml } from "./ui-html.ts";

const emptyMetrics = {
  allMessages: [],
  activeBranchMessages: [],
  treeTotals: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    assistantMessages: 0,
  },
  activeBranchTotals: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    assistantMessages: 0,
  },
};

describe("createCacheGraphHtml", () => {
  it("inlines built assets and injects boot data", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cache-graph-ui-"));
    await mkdir(path.join(dir, "assets"));
    await writeFile(
      path.join(dir, "index.html"),
      '<html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body></body></html>',
    );
    await writeFile(path.join(dir, "assets", "app.js"), "console.log('ok')");
    await writeFile(path.join(dir, "assets", "app.css"), "body{color:red}");

    const html = await createCacheGraphHtml(
      { metrics: emptyMetrics },
      { uiDistDir: dir },
    );

    expect(html).toContain("window.__CACHE_GRAPH_BOOT__");
    expect(html).toContain("console.log('ok')");
    expect(html).toContain("body{color:red}");
    expect(html).not.toContain('src="/assets/app.js"');
    expect(html.indexOf("window.__CACHE_GRAPH_BOOT__")).toBeLessThan(
      html.indexOf("console.log('ok')"),
    );
  });

  it("uses the Svelte 5 mount API in the UI entrypoint", async () => {
    const entrypoint = await readFile(
      new URL("./ui/src/main.ts", import.meta.url),
      "utf8",
    );

    expect(entrypoint).toContain('import { mount } from "svelte"');
    expect(entrypoint).toContain("mount(App, { target })");
    expect(entrypoint).not.toContain("new App({ target })");
  });
});
