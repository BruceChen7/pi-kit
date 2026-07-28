<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  title = "",
  nodes = [],
  _nodePath = "",
}: {
  title?: string;
  nodes?: { type: string; props: Record<string, unknown> }[];
  _nodePath?: string;
} = $props();
</script>

<section class="va-section">
  {#if title}
    <h2 class="va-section-title">{title}</h2>
  {/if}
  <div class="va-section-body">
    <VisualArtifactRenderer {nodes} basePath={`${_nodePath}.props.nodes`} />
  </div>
</section>

<style>
  .va-section {
    margin: 16px 0;
  }

  .va-section-title {
    margin: 0 0 8px;
    font-size: 16px;
    font-weight: 700;
    color: var(--va-text-primary);
    padding-bottom: 6px;
    border-bottom: 1px solid var(--va-border-default);
  }

  .va-section-body {
    padding-left: 2px;
  }
</style>
