<script lang="ts">
let {
  cards = [],
  columns = 2,
  _nodePath = "",
}: {
  cards?: {
    title?: string;
    description?: string;
    nodes?: { type: string; props: Record<string, unknown> }[];
  }[];
  columns?: number;
  _nodePath?: string;
} = $props();
</script>

{#if cards.length > 0}
  <div class="grid gap-3 my-3" style="grid-template-columns: repeat({columns}, 1fr)">
    {#each cards as card, i}
      <div class="rounded-xl border border-border bg-card p-4">
        {#if card.title}
          <h4 class="font-serif text-base font-medium tracking-[-0.01em] text-foreground mb-1">{card.title}</h4>
        {/if}
        {#if card.description}
          <p class="text-xs text-muted-foreground mb-2">{card.description}</p>
        {/if}
        {#if card.nodes?.length}
          <div class="pt-0.5">
            <VisualArtifactRenderer nodes={card.nodes} basePath={`${_nodePath}.props.cards.${i}.nodes`} />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
