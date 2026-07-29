<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template for recursion
import FileTree from "./file-tree.svelte";

type FileTreeItem = {
  name: string;
  type?: "file" | "directory";
  status?: "added" | "modified" | "deleted";
  children?: FileTreeItem[];
};

let {
  items = [],
  _depth = 0,
  _expanded,
  _toggle,
  _parentPath = "",
}: {
  items?: FileTreeItem[];
  _depth?: number;
  _expanded?: Set<string>;
  _toggle?: (path: string) => void;
  _parentPath?: string;
} = $props();

// Internal state for the root instance
let expanded = $state<Set<string>>(new Set());

function toggle(path: string): void {
  if (_toggle) {
    _toggle(path);
    return;
  }
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded = next;
}

function makePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

const activeExpanded = $derived(_expanded ?? expanded);
const activeToggle = $derived(_toggle ?? toggle);

const statusIcons: Record<string, string> = {
  added: "+",
  modified: "~",
  deleted: "-",
};

const statusColors: Record<string, string> = {
  added: "var(--va-accent-success)",
  modified: "var(--va-accent-warning)",
  deleted: "var(--va-accent-danger)",
};
</script>

{#if items.length > 0}
  <div class="va-file-tree">
    {#each items as item}
      {@const path = makePath(_parentPath, item.name)}
      {@const isDir = item.type === "directory" || (item.children != null && item.children.length > 0)}
      {@const isExpanded = activeExpanded.has(path)}
      {@const hasStatus = item.status != null && statusColors[item.status] != null}
      <div class="va-tree-node">
        <button
          type="button"
          class="va-tree-row"
          class:va-tree-dir={isDir}
          onclick={() => isDir && activeToggle(path)}
        >
          <span class="va-tree-icon">{isDir ? (isExpanded ? "▾" : "▸") : ((hasStatus && statusIcons[item.status!]) ?? "·")}</span>
          <span class="va-tree-name">{item.name}</span>
          {#if hasStatus}
            <span
              class="va-tree-status"
              style="background: {statusColors[item.status!]};"
            >
              {item.status}
            </span>
          {/if}
        </button>
        {#if isDir && isExpanded && item.children}
          <div class="va-tree-children" style="padding-left: 16px;">
            <FileTree
              items={item.children}
              _depth={_depth + 1}
              _expanded={activeExpanded}
              _toggle={activeToggle}
              _parentPath={path}
            />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .va-file-tree {
    margin: 12px 0;
    padding: 8px;
    background: var(--va-bg-code);
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    font-family: monospace;
    font-size: 13px;
  }

  .va-tree-row {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    padding: 2px 4px;
    background: transparent;
    border: none;
    color: var(--va-text-secondary);
    font-family: monospace;
    font-size: 13px;
    cursor: default;
    text-align: left;
    border-radius: 3px;
  }

  .va-tree-dir {
    cursor: pointer;
  }

  .va-tree-dir:hover {
    background: var(--va-bg-hover);
  }

  .va-tree-icon {
    width: 12px;
    color: var(--va-text-subtle);
    font-size: 10px;
    flex-shrink: 0;
  }

  .va-tree-name {
    color: var(--va-text-secondary);
  }

  .va-tree-status {
    display: inline-block;
    margin-left: auto;
    padding: 0 6px;
    font-size: 9px;
    font-weight: 700;
    line-height: 16px;
    border-radius: 999px;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .va-tree-children {
    border-left: 1px solid var(--va-border-default);
    margin-left: 5px;
  }
</style>
