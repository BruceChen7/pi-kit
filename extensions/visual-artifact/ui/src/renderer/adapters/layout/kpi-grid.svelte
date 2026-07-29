<script lang="ts">
type KpiItem = {
  label: string;
  value: string | number;
  trend?: "up" | "down" | "neutral";
  variant?: "default" | "success" | "warning" | "danger";
};

let { items = [], columns = 2 }: { items?: KpiItem[]; columns?: number } =
  $props();

const trendIcons: Record<string, string> = {
  up: "↑",
  down: "↓",
  neutral: "→",
};

const variantClasses: Record<string, string> = {
  default: "bg-card border-border",
  info: "bg-clay/10 border-clay/20",
  success: "bg-olive/10 border-olive/20",
  warning: "bg-amber/10 border-amber/20",
  danger: "bg-rust/10 border-rust/20",
};

const effectiveColumns = $derived(
  Number.isFinite(columns) ? Math.min(4, Math.max(1, Math.round(columns))) : 2,
);
</script>

{#if items.length > 0}
  <div
    class="va-kpi-grid grid gap-3 my-4"
    style="grid-template-columns: repeat({effectiveColumns}, minmax(0, 1fr))"
  >
    {#each items as item}
      {@const vc = variantClasses[item.variant ?? "default"] ?? variantClasses.default}
      <div class="rounded-xl border p-4 min-w-0 {vc}">
        <p class="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">{item.label}</p>
        <p class="text-2xl font-bold text-foreground leading-tight">
          {item.value}
          {#if item.trend && trendIcons[item.trend]}
            <span class="ml-1 text-lg {item.trend === 'up' ? 'text-olive' : item.trend === 'down' ? 'text-rust' : 'text-muted-foreground'}">{trendIcons[item.trend]}</span>
          {/if}
        </p>
      </div>
    {/each}
  </div>
{/if}

<style>
  @media (max-width: 820px) {
    .va-kpi-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    }
  }

  @media (max-width: 520px) {
    .va-kpi-grid {
      grid-template-columns: 1fr !important;
    }
  }
</style>
