<script lang="ts">
import FileTree from "./file-tree.svelte";
import {
  type FileTreeItem,
  fileTreeItemName,
  isFileTreeDirectory,
} from "./file-tree-shape.ts";

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

const statusColors: Record<string, string> = {
  added: "bg-olive/20 text-olive border-olive/30",
  modified: "bg-[#d9a84b]/20 text-[#d9a84b] border-[#d9a84b]/30",
  deleted: "bg-rust/20 text-rust border-rust/30",
};

const dirIcon = (open: boolean) => (open ? "▾" : "▸");
const fileIcon = (s?: string) => (s ? "+" : "·");
</script>

{#snippet treeItems()}
  {#each items as item}
    {@const name = fileTreeItemName(item)}
    {@const path = makePath(_parentPath, name)}
    {@const isDir = isFileTreeDirectory(item)}
    {@const isExpanded = activeExpanded.has(path)}
    {@const sc = item.status ? statusColors[item.status] : ""}
    <div>
      <button
        type="button"
        class="flex items-center gap-1 w-full px-1 py-0.5 rounded text-left text-primary-foreground {isDir ? 'cursor-pointer hover:bg-white/5' : 'cursor-default'}"
        onclick={() => isDir && activeToggle(path)}
      >
        <span class="w-3 text-muted-foreground text-[10px] shrink-0">
          {isDir ? dirIcon(isExpanded) : fileIcon(item.status)}
        </span>
        <span class="min-w-0 break-all">{name}</span>
        {#if item.note}
          <span class="min-w-0 truncate text-muted-foreground/70 text-[10px] italic" title={item.note}>
            — {item.note}
          </span>
        {/if}
        {#if sc}
          <span class="ml-auto text-[9px] font-bold uppercase leading-4 px-1.5 rounded-full {sc}">{item.status}</span>
        {/if}
      </button>
      {#if isDir && isExpanded && item.children}
        <div class="ml-4 border-l border-white/10 pl-3">
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
{/snippet}

{#if items.length > 0}
  {#if _depth === 0}
    <div class="rounded-xl border border-border bg-primary text-primary-foreground font-mono text-sm p-3 my-3">
      {@render treeItems()}
    </div>
  {:else}
    <div class="py-0.5">
      {@render treeItems()}
    </div>
  {/if}
{/if}
