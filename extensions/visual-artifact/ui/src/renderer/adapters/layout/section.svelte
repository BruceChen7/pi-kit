<script lang="ts">
let {
  title = "",
  nodes = [],
}: {
  title?: string;
  nodes?: { type: string; props: Record<string, unknown> }[];
} = $props();
</script>

<section class="va-section">
  {#if title}
    <h2 class="va-section-title">{title}</h2>
  {/if}
  <div class="va-section-body">
    <VisualArtifactRenderer {nodes} />
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
    color: #f1f5f9;
    padding-bottom: 6px;
    border-bottom: 1px solid #334155;
  }

  .va-section-body {
    padding-left: 2px;
  }
</style>
