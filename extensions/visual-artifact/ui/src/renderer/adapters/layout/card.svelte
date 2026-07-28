<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  title = "",
  description = "",
  nodes = [],
  _nodePath = "",
}: {
  title?: string;
  description?: string;
  nodes?: { type: string; props: Record<string, unknown> }[];
  _nodePath?: string;
} = $props();
</script>

<div class="va-card">
  {#if title}
    <h3 class="va-card-title">{title}</h3>
  {/if}
  {#if description}
    <p class="va-card-desc">{description}</p>
  {/if}
  {#if nodes.length > 0}
    <div class="va-card-body">
      <VisualArtifactRenderer {nodes} basePath={`${_nodePath}.props.nodes`} />
    </div>
  {/if}
</div>

<style>
  .va-card {
    padding: 16px;
    margin: 12px 0;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-lg);
    background: var(--va-bg-surface);
  }

  .va-card-title {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 700;
    color: var(--va-text-primary);
  }

  .va-card-desc {
    margin: 0 0 10px;
    color: var(--va-text-muted);
    font-size: 13px;
  }

  .va-card-body {
    padding-top: 4px;
  }
</style>
