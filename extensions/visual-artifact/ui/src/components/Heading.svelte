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
  <h1 class={cn("font-serif text-4xl sm:text-5xl font-medium tracking-[-0.025em] text-foreground", alignClass(), className)}>
    {@render children()}
  </h1>
{:else if level === 3}
  <h3 class={cn("font-serif text-2xl font-medium tracking-[-0.02em] text-foreground", alignClass(), className)}>
    {@render children()}
  </h3>
{:else if level === 4}
  <h4 class={cn("font-serif text-xl font-medium tracking-[-0.02em] text-foreground", alignClass(), className)}>
    {@render children()}
  </h4>
{:else}
  <h2 class={cn("font-serif text-3xl font-medium tracking-[-0.025em] text-foreground", alignClass(), className)}>
    {@render children()}
  </h2>
{/if}
