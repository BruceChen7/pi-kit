<script lang="ts">
let {
  items = [],
}: {
  items?: {
    title: string;
    nodes: { type: string; props: Record<string, unknown> }[];
  }[];
} = $props();

let openIndex = $state<number | null>(null);

function toggle(i: number): void {
  openIndex = openIndex === i ? null : i;
}
</script>

{#if items.length > 0}
  <div class="va-accordion">
    {#each items as item, i}
      <div class="va-accordion-item">
        <button
          type="button"
          class:va-accordion-open={openIndex === i}
          onclick={() => toggle(i)}
        >
          {item.title}
          <span class="va-chevron">{openIndex === i ? "▾" : "▸"}</span>
        </button>
        {#if openIndex === i}
          <div class="va-accordion-body">
            <VisualArtifactRenderer nodes={item.nodes} />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .va-accordion {
    margin: 12px 0;
    border: 1px solid #334155;
    border-radius: 8px;
    overflow: hidden;
  }

  .va-accordion-item {
    border-bottom: 1px solid #334155;
  }

  .va-accordion-item:last-child {
    border-bottom: none;
  }

  button {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 10px 14px;
    background: transparent;
    border: none;
    color: #e2e8f0;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }

  button:hover {
    background: rgba(255, 255, 255, 0.02);
  }

  .va-accordion-open {
    background: rgba(255, 255, 255, 0.03);
  }

  .va-chevron {
    color: #64748b;
    font-size: 11px;
    margin-left: 8px;
  }

  .va-accordion-body {
    padding: 8px 14px 14px;
  }
</style>
