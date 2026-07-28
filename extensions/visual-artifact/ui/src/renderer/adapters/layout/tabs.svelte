<script lang="ts">
let {
  tabs = [],
  activeIndex = 0,
  _nodePath = "",
}: {
  tabs?: {
    label: string;
    nodes: { type: string; props: Record<string, unknown> }[];
  }[];
  activeIndex?: number;
  _nodePath?: string;
} = $props();

function initialActiveTab(): number {
  return activeIndex;
}

let activeTab = $state<number>(initialActiveTab());

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
        <VisualArtifactRenderer
          nodes={tabs[activeTab].nodes}
          basePath={`${_nodePath}.props.tabs.${activeTab}.nodes`}
        />
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
    border-bottom: 1px solid var(--va-border-default);
    padding: 0;
  }

  button {
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--va-text-muted);
    font-size: 13px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  button:hover {
    color: var(--va-text-secondary);
  }

  .va-tab-active {
    color: var(--va-accent-primary-text);
    border-bottom-color: var(--va-accent-primary);
  }

  .va-tab-content {
    padding: 12px 4px;
  }
</style>
