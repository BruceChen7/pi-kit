<script lang="ts">
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

function initialOpenIndex(): number | null {
  const idx = items.findIndex((item) => item.defaultOpen === true);
  return idx >= 0 ? idx : null;
}

let openIndex = $state<number | null>(initialOpenIndex());

function toggle(i: number): void {
  openIndex = openIndex === i ? null : i;
}
</script>

{#if items.length > 0}
  <div class="rounded-xl border border-border bg-card overflow-hidden my-3">
    {#each items as item, i}
      <div class="border-b border-border last:border-b-0">
        <button
          type="button"
          class="flex justify-between items-center w-full px-4 py-3 text-left text-sm font-medium text-foreground bg-transparent border-none cursor-pointer hover:bg-muted/50 {openIndex === i ? 'bg-muted' : ''}"
          onclick={() => toggle(i)}
        >
          {item.title}
          <span class="text-muted-foreground text-xs ml-2 shrink-0">{openIndex === i ? "▾" : "▸"}</span>
        </button>
        {#if openIndex === i}
          <div class="px-4 pb-4">
            <VisualArtifactRenderer nodes={item.nodes} basePath={`${_nodePath}.props.items.${i}.nodes`} />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
