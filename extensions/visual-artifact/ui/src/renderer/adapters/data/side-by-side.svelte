<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  left = [],
  right = [],
  leftLabel = "",
  rightLabel = "",
  _nodePath = "",
}: {
  left?: { type: string; props: Record<string, unknown> }[];
  right?: { type: string; props: Record<string, unknown> }[];
  leftLabel?: string;
  rightLabel?: string;
  _nodePath?: string;
} = $props();
</script>

<div class="va-side-by-side">
  <div class="va-sbs-panel va-sbs-left">
    {#if leftLabel}
      <p class="va-sbs-label">{leftLabel}</p>
    {/if}
    <div class="va-sbs-content">
      <VisualArtifactRenderer nodes={left} basePath={`${_nodePath}.props.left`} />
    </div>
  </div>
  <div class="va-sbs-panel va-sbs-right">
    {#if rightLabel}
      <p class="va-sbs-label">{rightLabel}</p>
    {/if}
    <div class="va-sbs-content">
      <VisualArtifactRenderer nodes={right} basePath={`${_nodePath}.props.right`} />
    </div>
  </div>
</div>

<style>
  .va-side-by-side {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    margin: 12px 0;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    overflow: hidden;
  }

  .va-sbs-panel {
    min-width: 0;
    overflow-wrap: break-word;
  }

  .va-sbs-left {
    border-right: 1px solid var(--va-border-default);
    background:
      linear-gradient(var(--va-bg-danger-subtle), var(--va-bg-danger-subtle)),
      var(--va-bg-surface);
  }

  .va-sbs-right {
    background:
      linear-gradient(var(--va-bg-success-subtle), var(--va-bg-success-subtle)),
      var(--va-bg-surface);
  }

  .va-sbs-label {
    margin: 0;
    padding: 6px 12px;
    background: var(--va-bg-code);
    color: var(--va-text-subtle);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--va-border-default);
  }

  .va-sbs-left .va-sbs-label {
    color: var(--va-accent-danger-text);
  }

  .va-sbs-right .va-sbs-label {
    color: var(--va-accent-success-text);
  }

  .va-sbs-content {
    padding: 12px;
    min-width: 0;
    overflow-wrap: break-word;
  }

  .va-sbs-content :global(.va-node) {
    margin-bottom: 0;
  }

  @media (max-width: 640px) {
    .va-side-by-side {
      grid-template-columns: 1fr;
    }

    .va-sbs-left {
      border-right: none;
      border-bottom: 1px solid var(--va-border-default);
    }
  }
</style>
