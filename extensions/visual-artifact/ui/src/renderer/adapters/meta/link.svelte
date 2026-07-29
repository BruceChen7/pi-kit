<script lang="ts">
let { text = "", href = "" }: { text?: string; href?: string } = $props();
</script>

{#if href}
  <a {href} target="_blank" rel="noopener noreferrer" class="text-clay-dark hover:text-clay underline underline-offset-2 text-sm no-underline hover:underline">
    {text || href}
  </a>
{:else}
  <span class="text-foreground text-sm">{text}</span>
{/if}
