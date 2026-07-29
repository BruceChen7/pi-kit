<script lang="ts">
import Card from "$components/Card.svelte";
import { cn } from "$lib/utils";

let {
  label = "",
  value = "",
  trend = "",
}: { label?: string; value?: string | number; trend?: string } = $props();

const trendIcons: Record<string, string> = {
  up: "↑",
  down: "↓",
  neutral: "→",
};
</script>

<Card padding="sm" class="my-3">
  <p class="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground mb-1">{label}</p>
  <p class="font-serif text-2xl font-medium tracking-[-0.035em] text-foreground leading-tight">
    {value}
    {#if trend && trendIcons[trend]}
      <span
        class={cn(
          "ml-1 text-lg",
          trend === "up" && "text-olive",
          trend === "down" && "text-rust",
          trend === "neutral" && "text-muted-foreground",
        )}
      >
        {trendIcons[trend]}
      </span>
    {/if}
  </p>
</Card>
