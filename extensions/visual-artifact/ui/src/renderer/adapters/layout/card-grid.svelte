<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  cards = [],
  columns = 2,
}: {
  cards?: {
    title?: string;
    description?: string;
    nodes?: { type: string; props: Record<string, unknown> }[];
  }[];
  columns?: number;
} = $props();
</script>

{#if cards.length > 0}
  <div class="va-card-grid" style="grid-template-columns: repeat({columns}, 1fr)">
    {#each cards as card}
      <div class="va-card-grid-item">
        {#if card.title}
          <h4 class="va-card-grid-title">{card.title}</h4>
        {/if}
        {#if card.description}
          <p class="va-card-grid-desc">{card.description}</p>
        {/if}
        {#if card.nodes && card.nodes.length > 0}
          <div class="va-card-grid-body">
            <VisualArtifactRenderer nodes={card.nodes} />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .va-card-grid {
    display: grid;
    gap: 12px;
    margin: 12px 0;
  }

  .va-card-grid-item {
    padding: 14px;
    border: 1px solid #334155;
    border-radius: 9px;
    background: #1e293b;
  }

  .va-card-grid-title {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 700;
    color: #f1f5f9;
  }

  .va-card-grid-desc {
    margin: 0 0 8px;
    color: #94a3b8;
    font-size: 12px;
  }

  .va-card-grid-body {
    padding-top: 2px;
  }
</style>
