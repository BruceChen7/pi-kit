<script lang="ts">
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

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

const effectiveColumns = $derived(
  Number.isFinite(columns) ? Math.min(4, Math.max(1, Math.round(columns))) : 2,
);
</script>

{#if cards.length > 0}
  <div
    class="va-card-grid grid gap-3 my-4"
    data-columns={effectiveColumns}
    style="grid-template-columns: repeat({effectiveColumns}, minmax(0, 1fr))"
  >
    {#each cards as card, i}
      <div class="min-w-0 rounded-xl border border-border bg-card p-4">
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

<style>
  @media (max-width: 900px) {
    .va-card-grid:not([data-columns="1"]) {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
  }

  @media (max-width: 560px) {
    .va-card-grid {
      grid-template-columns: 1fr !important;
    }
  }
</style>
