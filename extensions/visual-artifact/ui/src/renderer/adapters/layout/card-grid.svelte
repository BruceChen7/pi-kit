<script lang="ts">
import { isRenderableCard } from "../../renderable-node.ts";
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

const visibleCards = $derived(
  cards
    .map((card, index) => ({ card, index }))
    .filter((entry) => isRenderableCard(entry.card)),
);
const effectiveColumns = $derived(
  Number.isFinite(columns)
    ? Math.min(visibleCards.length, 4, Math.max(1, Math.round(columns)))
    : Math.min(visibleCards.length, 2),
);
</script>

{#if visibleCards.length > 0}
  <div class="va-card-grid-container">
    <div
      class="va-card-grid grid gap-3 my-4"
      data-columns={effectiveColumns}
      style="grid-template-columns: repeat({effectiveColumns}, minmax(0, 1fr))"
    >
    {#each visibleCards as { card, index }}
      <div class="min-w-0 rounded-xl border border-border bg-card p-4">
        {#if card.title}
          <h4 class="font-serif text-base font-medium tracking-[-0.01em] text-foreground mb-1">{card.title}</h4>
        {/if}
        {#if card.description}
          <p class="text-xs text-muted-foreground mb-2">{card.description}</p>
        {/if}
        {#if card.nodes?.length}
          <div class="pt-0.5">
            <VisualArtifactRenderer nodes={card.nodes} basePath={`${_nodePath}.props.cards.${index}.nodes`} />
          </div>
        {/if}
      </div>
    {/each}
    </div>
  </div>
{/if}

<style>
  /*
    Container queries respond to the grid's actual width, not the window —
    opening the feedback panel or resizing the window reflows correctly.
  */
  .va-card-grid-container {
    container-type: inline-size;
  }

  @container (max-width: 900px) {
    .va-card-grid:not([data-columns="1"]) {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
  }

  @container (max-width: 560px) {
    .va-card-grid {
      grid-template-columns: 1fr !important;
    }
  }
</style>
