<script lang="ts">
import { type Tone } from "$lib/tone";

let {
  tone = "default",
  padding = "md",
  class: className = "",
  children,
}: {
  tone?: Tone | string;
  padding?: "none" | "sm" | "md" | "lg";
  class?: string;
  children?: import("svelte").Snippet;
} = $props();

const paddingClass = $derived<string>(() => {
  const map: Record<string, string> = {
    none: "",
    sm: "p-3",
    md: "p-5",
    lg: "p-7",
  };
  return map[padding] ?? map.md;
});
</script>

<div
  class={cn(
    "rounded-2xl border bg-card text-card-foreground shadow-card",
    toneBorderClass(tone),
    paddingClass(),
    className,
  )}
>
  {#if children}
    {@render children()}
  {/if}
</div>
