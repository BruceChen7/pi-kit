<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
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
</script>

{#if cards.length > 0}
  <div class="va-card-grid" style="grid-template-columns: repeat({columns}, 1fr)">
    {#each cards as card, i}
      <div class="va-card-grid-item">
        {#if card.title}
          <h4 class="va-card-grid-title">{card.title}</h4>
        {/if}
        {#if card.description}
          <p class="va-card-grid-desc">{card.description}</p>
        {/if}
        {#if card.nodes && card.nodes.length > 0}
          <div class="va-card-grid-body">
            <VisualArtifactRenderer
              nodes={card.nodes}
              basePath={`${_nodePath}.props.cards.${i}.nodes`}
            />
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
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    background: var(--va-bg-surface);
  }

  .va-card-grid-title {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 700;
    color: var(--va-text-primary);
  }

  .va-card-grid-desc {
    margin: 0 0 8px;
    color: var(--va-text-muted);
    font-size: 12px;
  }

  .va-card-grid-body {
    padding-top: 2px;
  }
</style>
