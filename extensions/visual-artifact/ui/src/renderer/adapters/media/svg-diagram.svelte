<script lang="ts">
let { html = "" }: { html?: string } = $props();

// SVG diagrams require sandboxed iframe which may not work in Glimpse.
// Fallback: attempt to render inline SVG, show source on failure.
</script>

<div class="va-svg-diagram">
  {#if html.includes("<svg")}
    <div class="va-svg-inline">
      {@html html}
    </div>
  {:else}
    <p class="va-svg-fallback">
      SVG diagram rendering not available. Source shown below:
    </p>
    <pre class="va-svg-source">{html}</pre>
  {/if}
</div>

<style>
  .va-svg-diagram {
    margin: 12px 0;
  }

  .va-svg-inline {
    padding: 8px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    background: var(--va-bg-surface);
  }

  .va-svg-inline :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .va-svg-fallback {
    margin: 0 0 8px;
    color: var(--va-accent-warning);
    font-size: 12px;
  }

  .va-svg-source {
    margin: 0;
    padding: 10px;
    background: var(--va-bg-code);
    border-radius: var(--va-radius-sm);
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    color: var(--va-text-secondary);
    white-space: pre-wrap;
  }
</style>
