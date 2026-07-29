<script lang="ts">
type KpiItem = {
  label: string;
  value: string | number;
  trend?: "up" | "down" | "neutral";
  variant?: "default" | "success" | "warning" | "danger";
};

let {
  items = [],
  columns = 2,
}: {
  items?: KpiItem[];
  columns?: number;
} = $props();

const trendIcons: Record<string, string> = {
  up: "↑",
  down: "↓",
  neutral: "→",
};

const trendColors: Record<string, string> = {
  up: "var(--va-accent-success)",
  down: "var(--va-accent-danger)",
  neutral: "var(--va-accent-neutral)",
};

const variantColors: Record<string, { bg: string; border: string }> = {
  default: { bg: "var(--va-bg-surface)", border: "var(--va-border-default)" },
  info: {
    bg: "var(--va-bg-info-subtle)",
    border: "var(--va-border-info-subtle)",
  },
  success: {
    bg: "var(--va-bg-success-subtle)",
    border: "var(--va-border-success-subtle)",
  },
  warning: {
    bg: "var(--va-bg-warning-subtle)",
    border: "var(--va-border-warning-subtle)",
  },
  danger: {
    bg: "var(--va-bg-danger-subtle)",
    border: "var(--va-border-danger-subtle)",
  },
};

const effectiveColumns = $derived(Math.min(3, Math.max(1, columns)));
</script>

{#if items.length > 0}
  <div
    class="va-kpi-grid"
    style="grid-template-columns: repeat({effectiveColumns}, minmax(0, 1fr))"
  >
    {#each items as item}
      {@const variant = item.variant ?? "default"}
      {@const colors = variantColors[variant] ?? variantColors.default}
      <div
        class="va-kpi-card"
        style="background: {colors.bg}; border-color: {colors.border};"
      >
        <p class="va-kpi-label">{item.label}</p>
        <p class="va-kpi-value">
          {item.value}
          {#if item.trend && trendIcons[item.trend]}
            <span
              class="va-kpi-trend"
              style="color: {trendColors[item.trend] ?? 'var(--va-accent-neutral)'}"
            >
              {trendIcons[item.trend]}
            </span>
          {/if}
        </p>
      </div>
    {/each}
  </div>
{/if}

<style>
  .va-kpi-grid {
    display: grid;
    gap: 12px;
    margin: 12px 0;
  }

  .va-kpi-card {
    padding: 16px;
    border: 1px solid;
    border-radius: var(--va-radius-md);
    min-width: 0;
  }

  .va-kpi-label {
    margin: 0 0 6px;
    color: var(--va-text-subtle);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .va-kpi-value {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    color: var(--va-text-primary);
    line-height: 1.2;
  }

  .va-kpi-trend {
    font-size: 18px;
    margin-left: 6px;
  }

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
