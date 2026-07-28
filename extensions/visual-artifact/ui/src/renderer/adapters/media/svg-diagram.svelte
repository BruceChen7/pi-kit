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
    border: 1px solid #334155;
    border-radius: 8px;
    background: #1e293b;
  }

  .va-svg-inline :global(svg) {
    max-width: 100%;
    height: auto;
  }

  .va-svg-fallback {
    margin: 0 0 8px;
    color: #f59e0b;
    font-size: 12px;
  }

  .va-svg-source {
    margin: 0;
    padding: 10px;
    background: #0f172a;
    border-radius: 6px;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.5;
    color: #cbd5e1;
    white-space: pre-wrap;
  }
</style>
