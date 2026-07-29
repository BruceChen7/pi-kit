<script lang="ts">
import { cn } from "$lib/utils";

let {
  level = 2,
  align = "left",
  class: className = "",
  children,
}: {
  level?: 1 | 2 | 3 | 4;
  align?: "left" | "center" | "right";
  class?: string;
  children?: import("svelte").Snippet;
} = $props();

const alignClass = $derived(() => {
  const map: Record<string, string> = {
    center: "text-center",
    right: "text-right",
  };
  return map[align] ?? "";
});
</script>

{#if level === 1}
  <h1 class={cn("va-heading va-heading-1 font-serif text-[clamp(2.25rem,4.5vw,3rem)] leading-[1.08] font-medium tracking-[-0.025em] text-foreground mb-5", alignClass(), className)}>
    {@render children()}
  </h1>
{:else if level === 3}
  <h3 class={cn("va-heading font-serif text-2xl leading-tight font-medium tracking-[-0.02em] text-foreground mt-6 mb-2.5", alignClass(), className)}>
    {@render children()}
  </h3>
{:else if level === 4}
  <h4 class={cn("va-heading font-serif text-xl leading-snug font-medium tracking-[-0.02em] text-foreground mt-5 mb-2", alignClass(), className)}>
    {@render children()}
  </h4>
{:else}
  <h2 class={cn("va-heading font-serif text-3xl leading-tight font-medium tracking-[-0.025em] text-foreground mt-8 mb-3", alignClass(), className)}>
    {@render children()}
  </h2>
{/if}

<style>
  .va-heading {
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
</style>
