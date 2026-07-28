<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  title = "",
  description = "",
  nodes = [],
}: {
  title?: string;
  description?: string;
  nodes?: { type: string; props: Record<string, unknown> }[];
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
      <VisualArtifactRenderer {nodes} />
    </div>
  {/if}
</div>

<style>
  .va-card {
    padding: 16px;
    margin: 12px 0;
    border: 1px solid #334155;
    border-radius: 10px;
    background: #1e293b;
  }

  .va-card-title {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 700;
    color: #f1f5f9;
  }

  .va-card-desc {
    margin: 0 0 10px;
    color: #94a3b8;
    font-size: 13px;
  }

  .va-card-body {
    padding-top: 4px;
  }
</style>
