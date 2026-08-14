/**
 * FileTree item shape helpers.
 *
 * The renderer historically accepted `name`-based items; model-generated specs
 * sometimes use `path`-based items (e.g. diff-review File Map sections emit
 * `{ path, children, status }`). Keep both shapes working: derive the display
 * label from `path` when `name` is absent, and treat items with children as
 * directories.
 */

export type FileTreeItem = {
  name?: string;
  path?: string;
  type?: "file" | "directory";
  status?: "added" | "modified" | "deleted";
  note?: string;
  children?: FileTreeItem[];
};

/** Display label for an item: `name`, else the basename of `path`. */
export function fileTreeItemName(item: FileTreeItem): string {
  if (item.name) return item.name;
  if (item.path) {
    const withoutSlash = item.path.replace(/\/+$/u, "");
    const lastSlash = withoutSlash.lastIndexOf("/");
    return lastSlash >= 0 ? withoutSlash.slice(lastSlash + 1) : withoutSlash;
  }
  return "";
}

/** Directory detection: explicit `type`, or the presence of children. */
export function isFileTreeDirectory(item: FileTreeItem): boolean {
  return item.type === "directory" || (item.children?.length ?? 0) > 0;
}
