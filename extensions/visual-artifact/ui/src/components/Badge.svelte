<script lang="ts">
import { type Tone, toneBadgeClass } from "$lib/tone";
import { cn } from "$lib/utils";

let {
  variant = "default",
  class: className = "",
  children,
}: {
  variant?: Tone | "outline" | "secondary" | string;
  class?: string;
  children?: import("svelte").Snippet;
} = $props();
</script>

<span
  class={cn(
    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
    toneBadgeClass(variant),
    className,
  )}
>
  {#if children}
    {@render children()}
  {/if}
</span>
