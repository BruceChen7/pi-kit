<script lang="ts">
let { svg = "" }: { svg?: string } = $props();
</script>

<div class="my-3">
  {#if svg.includes("<svg")}
    <div class="rounded-xl border border-border bg-card p-3">
      {@html svg}
    </div>
  {:else}
    <p class="text-[#d9a84b] text-xs mb-2">SVG diagram rendering not available. Source shown below:</p>
    <pre class="p-3 bg-[#141413] text-[#f0eee6] rounded-lg font-mono text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto">{svg}</pre>
  {/if}
</div>

<style>
  :global(.va-svg-inline svg) { max-width: 100%; height: auto; }
</style>
