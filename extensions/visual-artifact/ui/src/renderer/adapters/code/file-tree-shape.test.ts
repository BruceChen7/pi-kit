import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type FileTreeItem,
  fileTreeItemName,
  isFileTreeDirectory,
} from "./file-tree-shape.ts";

describe("fileTreeItemName", () => {
  it("prefers the name field when present (name-shaped items)", () => {
    const item: FileTreeItem = { name: "go.mod", status: "modified" };
    expect(fileTreeItemName(item)).toBe("go.mod");
  });

  it("derives the label from the path basename (path-shaped items)", () => {
    // Regression: diff-review File Map specs emit { path, children, status }
    // instead of { name, ... }; the tree must still show file names.
    expect(fileTreeItemName({ path: "internal/" })).toBe("internal");
    expect(
      fileTreeItemName({
        path: "client/account_upp_client.go",
        status: "modified",
      }),
    ).toBe("account_upp_client.go");
    expect(
      fileTreeItemName({
        path: "sp-workspace.yml",
        status: "modified",
      }),
    ).toBe("sp-workspace.yml");
  });

  it("strips trailing slashes from directory paths", () => {
    expect(fileTreeItemName({ path: "a/b/c/" })).toBe("c");
  });

  it("returns an empty label when neither name nor path is present", () => {
    expect(fileTreeItemName({})).toBe("");
  });
});

describe("isFileTreeDirectory", () => {
  it("treats items with children as directories", () => {
    expect(
      isFileTreeDirectory({
        path: "internal/",
        children: [{ path: "x.go" }],
      }),
    ).toBe(true);
  });

  it("honors the explicit type", () => {
    expect(isFileTreeDirectory({ name: "d", type: "directory" })).toBe(true);
    expect(isFileTreeDirectory({ name: "f", type: "file" })).toBe(false);
  });

  it("treats leaf items as files", () => {
    expect(isFileTreeDirectory({ path: "sp-workspace.yml" })).toBe(false);
  });
});

describe("FileTree adapter component", () => {
  it("renders through the shared shape helpers and keeps the note", async () => {
    const source = await readFile(
      path.join(
        process.cwd(),
        "extensions/visual-artifact/ui/src/renderer/adapters/code/file-tree.svelte",
      ),
      "utf8",
    );

    expect(source).toContain("fileTreeItemName(");
    expect(source).toContain("isFileTreeDirectory(");
    expect(source).toContain("item.note");
  });
});
