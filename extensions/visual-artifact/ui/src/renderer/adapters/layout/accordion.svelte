<script lang="ts">
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  items = [],
  _nodePath = "",
}: {
  items?: {
    title: string;
    defaultOpen?: boolean;
    nodes: { type: string; props: Record<string, unknown> }[];
  }[];
  _nodePath?: string;
} = $props();

// 默认全部展开;单项设 defaultOpen: false 可默认折叠
function initialOpenSet(): Set<number> {
  const set = new Set<number>();
  items.forEach((item, i) => {
    if (item.defaultOpen !== false) {
      set.add(i);
    }
  });
  return set;
}

let openSet = $state<Set<number>>(initialOpenSet());

function toggle(i: number): void {
  const next = new Set(openSet);
  if (next.has(i)) {
    next.delete(i);
  } else {
    next.add(i);
  }
  openSet = next;
}
</script>

{#if items.length > 0}
  <div class="rounded-xl border border-border bg-card overflow-hidden my-3">
    {#each items as item, i}
      <div class="border-b border-border last:border-b-0">
        <button
          type="button"
          class="flex justify-between items-center w-full px-4 py-3 text-left text-sm font-medium text-foreground bg-transparent border-none cursor-pointer hover:bg-muted/50 {openSet.has(i) ? 'bg-muted' : ''}"
          onclick={() => toggle(i)}
        >
          {item.title}
          <span class="text-muted-foreground text-xs ml-2 shrink-0">{openSet.has(i) ? "▾" : "▸"}</span>
        </button>
        {#if openSet.has(i)}
          <div class="px-4 pb-4">
            <VisualArtifactRenderer nodes={item.nodes} basePath={`${_nodePath}.props.items.${i}.nodes`} />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
