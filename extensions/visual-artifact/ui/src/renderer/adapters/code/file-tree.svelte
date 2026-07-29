<script lang="ts">
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

{#if items.length > 0}
  <div class="rounded-xl border border-border bg-[#141413] text-[#f0eee6] font-mono text-sm p-3 my-3">
    {#each items as item}
      {@const path = makePath(_parentPath, item.name)}
      {@const isDir = item.type === "directory" || (item.children?.length ?? 0) > 0}
      {@const isExpanded = activeExpanded.has(path)}
      {@const sc = item.status ? statusColors[item.status] : ""}
      <div>
        <button
          type="button"
          class="flex items-center gap-1 w-full px-1 py-0.5 rounded text-left text-[#f0eee6] {isDir ? 'cursor-pointer hover:bg-white/5' : 'cursor-default'}"
          onclick={() => isDir && activeToggle(path)}
        >
          <span class="w-3 text-[#6b6a63] text-[10px] shrink-0">
            {isDir ? dirIcon(isExpanded) : fileIcon(item.status)}
          </span>
          <span>{item.name}</span>
          {#if sc}
            <span class="ml-auto text-[9px] font-bold uppercase leading-4 px-1.5 rounded-full {sc}">{item.status}</span>
          {/if}
        </button>
        {#if isDir && isExpanded && item.children}
          <div class="ml-4 border-l border-border/30 pl-3">
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
