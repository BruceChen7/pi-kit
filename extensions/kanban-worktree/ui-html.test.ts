import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createKanbanHtml } from "./ui-html.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kanban-worktree-ui-html-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("creates self-contained Kanban HTML with boot data", async () => {
  await mkdir(path.join(dir, "assets"));
  await writeFile(
    path.join(dir, "index.html"),
    [
      "<!doctype html><html><head>",
      '<script type="module" src="/assets/app.js"></script>',
      '<link rel="stylesheet" href="/assets/app.css">',
      "</head><body></body></html>",
    ].join(""),
  );
  await writeFile(path.join(dir, "assets", "app.js"), "console.log('app');");
  await writeFile(path.join(dir, "assets", "app.css"), "body { color: red; }");

  const html = await createKanbanHtml("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: vi.fn().mockResolvedValue({
      result: [
        {
          issueId: "todo-workflow:todo-1",
          originProvider: "todo-workflow",
          originId: "todo-1",
          title: "Todo 1",
          status: "in-box",
        },
      ],
    }),
  });

  expect(html).toContain(
    "<script type=\"module\" >console.log('app');</script>",
  );
  expect(html).toContain(
    '<style rel="stylesheet" >body { color: red; }</style>',
  );
  expect(html).toContain("window.__KANBAN_BOOT__=");
  expect(html).toContain("todo-workflow:todo-1");
  expect(html).toContain("/tmp/kanban.sock");
});

test("uses empty content for missing built assets", async () => {
  await writeFile(
    path.join(dir, "index.html"),
    '<script type="module" src="/assets/missing.js"></script>',
  );

  const html = await createKanbanHtml("/tmp/kanban.sock", {
    uiDistDir: dir,
    request: vi.fn().mockResolvedValue({ result: [] }),
  });

  expect(html).toContain('<script type="module" ></script>');
  expect(html).toContain("window.__KANBAN_BOOT__=");
});
