<script lang="ts">
import { cn } from "$lib/utils";

let {
  caption = "",
  minWidth = "100%",
  class: className = "",
  children,
}: {
  caption?: string;
  minWidth?: string;
  class?: string;
  children?: import("svelte").Snippet;
} = $props();
</script>

<div class={cn("overflow-x-auto rounded-xl border border-border bg-card shadow-card-sm", className)}>
  <table class="w-full table-auto text-sm" style:min-width={minWidth}>
    {#if caption}
      <caption class="caption-bottom p-3 text-left text-sm text-muted-foreground">{caption}</caption>
    {/if}
    {#if children}
      {@render children()}
    {/if}
  </table>
</div>
