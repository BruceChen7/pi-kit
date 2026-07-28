<script lang="ts">
let {
  items = [],
  _nodePath = "",
}: {
  items?: {
    title: string;
    nodes: { type: string; props: Record<string, unknown> }[];
  }[];
  _nodePath?: string;
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
            <VisualArtifactRenderer
              nodes={item.nodes}
              basePath={`${_nodePath}.props.items.${i}.nodes`}
            />
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .va-accordion {
    margin: 12px 0;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    overflow: hidden;
  }

  .va-accordion-item {
    border-bottom: 1px solid var(--va-border-default);
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
    color: var(--va-text-secondary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }

  button:hover {
    background: var(--va-bg-hover);
  }

  .va-accordion-open {
    background: var(--va-bg-selected);
  }

  .va-chevron {
    color: var(--va-text-subtle);
    font-size: 11px;
    margin-left: 8px;
  }

  .va-accordion-body {
    padding: 8px 14px 14px;
  }
</style>
