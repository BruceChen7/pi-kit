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

function semanticVariant(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "good":
      return "success";
    case "bad":
      return "danger";
    case "ugly":
      return "warning";
    case "questions":
      return "info";
    default:
      return "default";
  }
}

const variant = $derived(semanticVariant(title));
</script>

<div class="va-card" data-variant={variant}>
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

  .va-card[data-variant="success"] {
    border-left: 3px solid var(--va-accent-success);
  }

  .va-card[data-variant="danger"] {
    border-left: 3px solid var(--va-accent-danger);
  }

  .va-card[data-variant="warning"] {
    border-left: 3px solid var(--va-accent-warning);
  }

  .va-card[data-variant="info"] {
    border-left: 3px solid var(--va-accent-primary);
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
