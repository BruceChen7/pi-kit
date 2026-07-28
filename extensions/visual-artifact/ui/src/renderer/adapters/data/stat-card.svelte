<script lang="ts">
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

const trendColors: Record<string, string> = {
  up: "var(--va-accent-success)",
  down: "var(--va-accent-danger)",
  neutral: "var(--va-accent-neutral)",
};
</script>

<div class="va-stat-card">
  <p class="va-stat-label">{label}</p>
  <p class="va-stat-value">
    {value}
    {#if trend && trendIcons[trend]}
      <span class="va-trend" style="color: {trendColors[trend] ?? 'var(--va-accent-neutral)'}">
        {trendIcons[trend]}
      </span>
    {/if}
  </p>
</div>

<style>
  .va-stat-card {
    padding: 16px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    background: var(--va-bg-surface);
    margin: 8px 0;
  }

  .va-stat-label {
    margin: 0 0 6px;
    color: var(--va-text-subtle);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .va-stat-value {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    color: var(--va-text-primary);
    line-height: 1.2;
  }

  .va-trend {
    font-size: 18px;
    margin-left: 6px;
  }
</style>
