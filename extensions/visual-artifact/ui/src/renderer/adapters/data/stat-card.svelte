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
  up: "#22c55e",
  down: "#ef4444",
  neutral: "#94a3b8",
};
</script>

<div class="va-stat-card">
  <p class="va-stat-label">{label}</p>
  <p class="va-stat-value">
    {value}
    {#if trend && trendIcons[trend]}
      <span class="va-trend" style="color: {trendColors[trend] ?? '#94a3b8'}">
        {trendIcons[trend]}
      </span>
    {/if}
  </p>
</div>

<style>
  .va-stat-card {
    padding: 16px;
    border: 1px solid #334155;
    border-radius: 9px;
    background: #1e293b;
    margin: 8px 0;
  }

  .va-stat-label {
    margin: 0 0 6px;
    color: #64748b;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .va-stat-value {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    color: #f1f5f9;
    line-height: 1.2;
  }

  .va-trend {
    font-size: 18px;
    margin-left: 6px;
  }
</style>
