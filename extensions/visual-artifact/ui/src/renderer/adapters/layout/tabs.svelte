<script lang="ts">
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

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

// Capture initial value only — prop changes after mount should not override user interaction
function defaultIndex(): number {
  return activeIndex;
}
let activeTab = $state(defaultIndex());

function selectTab(index: number): void {
  activeTab = index;
}
</script>

{#if tabs.length > 0}
  <div class="my-3">
    <div class="flex gap-0 border-b border-border" role="tablist">
      {#each tabs as tab, i}
        <button
          type="button"
          class="px-4 py-2 text-sm font-medium bg-transparent border-none cursor-pointer transition-colors {activeTab === i ? 'text-clay border-b-2 border-clay' : 'text-muted-foreground hover:text-foreground'}"
          role="tab"
          aria-selected={activeTab === i}
          onclick={() => selectTab(i)}
        >
          {tab.label}
        </button>
      {/each}
    </div>
    <div class="pt-3" role="tabpanel">
      {#if tabs[activeTab]}
        <VisualArtifactRenderer nodes={tabs[activeTab].nodes} basePath={`${_nodePath}.props.tabs.${activeTab}.nodes`} />
      {/if}
    </div>
  </div>
{/if}
