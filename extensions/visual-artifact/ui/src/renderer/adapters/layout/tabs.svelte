<script lang="ts">
let {
  tabs = [],
  activeIndex = 0,
}: {
  tabs?: {
    label: string;
    nodes: { type: string; props: Record<string, unknown> }[];
  }[];
  activeIndex?: number;
} = $props();

let activeTab = $state<number>(0);

function selectTab(index: number): void {
  activeTab = index;
}
</script>

{#if tabs.length > 0}
  <div class="va-tabs">
    <div class="va-tab-bar" role="tablist">
      {#each tabs as tab, i}
        <button
          type="button"
          class:va-tab-active={activeTab === i}
          onclick={() => selectTab(i)}
          role="tab"
          aria-selected={activeTab === i}
        >
          {tab.label}
        </button>
      {/each}
    </div>
    <div class="va-tab-content" role="tabpanel">
      {#if tabs[activeTab]}
        <VisualArtifactRenderer nodes={tabs[activeTab].nodes} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .va-tabs {
    margin: 12px 0;
  }

  .va-tab-bar {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid #334155;
    padding: 0;
  }

  button {
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #94a3b8;
    font-size: 13px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  button:hover {
    color: #e2e8f0;
  }

  .va-tab-active {
    color: #60a5fa;
    border-bottom-color: #3b82f6;
  }

  .va-tab-content {
    padding: 12px 4px;
  }
</style>
