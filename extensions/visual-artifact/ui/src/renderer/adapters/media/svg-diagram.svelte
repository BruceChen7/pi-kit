<script lang="ts">
let { html = "" }: { html?: string } = $props();
</script>

<div class="my-3">
  {#if html.includes("<svg")}
    <div class="rounded-xl border border-border bg-card p-3">
      {@html html}
    </div>
  {:else}
    <p class="text-[#d9a84b] text-xs mb-2">SVG diagram rendering not available. Source shown below:</p>
    <pre class="p-3 bg-[#141413] text-[#f0eee6] rounded-lg font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto">{html}</pre>
  {/if}
</div>

<style>
  :global(.va-svg-inline svg) { max-width: 100%; height: auto; }
</style>
