<script lang="ts">
type CacheUsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  assistantMessages: number;
};

type AssistantUsageMetric = {
  sequence: number;
  activeBranchSequence?: number;
  entryId: string;
  timestamp: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cacheHitPercent: number;
  isOnActiveBranch: boolean;
};

type CacheSessionMetrics = {
  allMessages: AssistantUsageMetric[];
  activeBranchMessages: AssistantUsageMetric[];
  treeTotals: CacheUsageTotals;
  activeBranchTotals: CacheUsageTotals;
};

type DashboardInitialView = "graph" | "stats";
type ChartView = "per-turn" | "cumulative-percent" | "cumulative-total";
type Status = "idle" | "loading" | "error" | "success";

type ChartPoint = {
  x: number;
  y: number;
  value: number;
};

type ChartScale = {
  min: number;
  max: number;
  span: number;
};

type ChartTick = {
  y: number;
  value: number;
  label: string;
};

type BootData = {
  initialView: DashboardInitialView;
  metrics: CacheSessionMetrics;
};

type DashboardResult =
  | { type: "metrics"; ok: true; metrics: CacheSessionMetrics }
  | { type: "export-result"; ok: true; filePath: string }
  | { type: "error"; ok: false; action: "refresh" | "export"; message: string };

const CHART_WIDTH = 640;
const CHART_HEIGHT = 220;
const CHART_TOP = 22;
const CHART_RIGHT = 618;
const CHART_BOTTOM = 192;
const CHART_LEFT = 62;

declare global {
  interface Window {
    __CACHE_GRAPH_BOOT__?: BootData;
    glimpse?: {
      send(message: unknown): void;
    };
  }
}

const boot = window.__CACHE_GRAPH_BOOT__ ?? {
  initialView: "graph",
  metrics: emptyMetrics(),
};
const bootRows = boot.metrics.allMessages.length;

let metrics = $state<CacheSessionMetrics>(boot.metrics);
let initialView = $state<DashboardInitialView>(boot.initialView);
let chartView = $state<ChartView>("per-turn");
let status = $state<Status>("idle");
let statusMessage = $state("");
let lastUpdated = $state(new Date().toLocaleTimeString());
let silentRefreshPending = false;
let didRequestInitialRefresh = false;
let statusDismissTimer: ReturnType<typeof window.setTimeout> | null = null;
let bridgeReady = $state(typeof window.glimpse?.send === "function");
let refreshAttempts = $state(0);
let refreshResponses = $state(0);

const chartRows = $derived(
  metrics.activeBranchMessages.length > 0
    ? metrics.activeBranchMessages
    : metrics.allMessages,
);
const chartValuesForView = $derived(chartValues(chartRows, chartView));
const chartScale = $derived(chartValueScale(chartValuesForView, chartView));
const chartTicks = $derived(buildChartTicks(chartScale, chartView));
const chartData = $derived(buildChartData(chartValuesForView, chartScale));
const hasOtherPaths = $derived(
  metrics.allMessages.some((row) => !row.isOnActiveBranch),
);
const chartPolyline = $derived(
  chartData
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" "),
);

function refresh(): void {
  showStatus("loading", "Refreshing metrics...");
  silentRefreshPending = false;
  requestMetricsRefresh();
}

function exportCsv(): void {
  showStatus("loading", "Exporting CSV...");
  window.glimpse?.send({ type: "export" });
}

function handleDashboardResult(event: Event): void {
  const result = (event as CustomEvent<DashboardResult>).detail;
  if (result.type === "metrics") {
    const isSilentRefresh = silentRefreshPending;
    silentRefreshPending = false;
    refreshResponses += 1;
    metrics = result.metrics;
    lastUpdated = new Date().toLocaleTimeString();
    if (!isSilentRefresh) {
      showStatus("success", "Metrics refreshed.", true);
    }
    return;
  }
  if (result.type === "export-result") {
    showStatus("success", `Exported CSV to ${result.filePath}`, true);
    return;
  }
  showStatus("error", `${result.action} failed: ${result.message}`);
}

function requestMetricsRefresh(): boolean {
  bridgeReady = typeof window.glimpse?.send === "function";
  if (!window.glimpse) return false;
  refreshAttempts += 1;
  window.glimpse.send({ type: "refresh" });
  return true;
}

function showStatus(
  nextStatus: Status,
  message: string,
  autoDismiss = false,
): void {
  clearStatusDismissTimer();
  status = nextStatus;
  statusMessage = message;
  if (autoDismiss) {
    statusDismissTimer = window.setTimeout(() => {
      statusMessage = "";
      status = "idle";
      statusDismissTimer = null;
    }, 2600);
  }
}

function clearStatusDismissTimer(): void {
  if (statusDismissTimer === null) return;
  window.clearTimeout(statusDismissTimer);
  statusDismissTimer = null;
}

$effect(() => {
  window.addEventListener("cache-graph:metrics", handleDashboardResult);
  window.addEventListener("cache-graph:export-result", handleDashboardResult);
  window.addEventListener("cache-graph:error", handleDashboardResult);
  return () => {
    window.removeEventListener("cache-graph:metrics", handleDashboardResult);
    window.removeEventListener(
      "cache-graph:export-result",
      handleDashboardResult,
    );
    window.removeEventListener("cache-graph:error", handleDashboardResult);
    clearStatusDismissTimer();
  };
});

$effect(() => {
  if (didRequestInitialRefresh || metrics.allMessages.length > 0) return;
  didRequestInitialRefresh = true;

  const timers = [100, 500, 1500].map((delay) =>
    window.setTimeout(() => {
      if (metrics.allMessages.length > 0) return;
      silentRefreshPending = true;
      if (!requestMetricsRefresh()) silentRefreshPending = false;
    }, delay),
  );

  return () => {
    for (const timer of timers) window.clearTimeout(timer);
  };
});

$effect(() => {
  const timer = window.setInterval(() => {
    bridgeReady = typeof window.glimpse?.send === "function";
  }, 250);

  return () => window.clearInterval(timer);
});

function emptyMetrics(): CacheSessionMetrics {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    assistantMessages: 0,
  };
  return {
    allMessages: [],
    activeBranchMessages: [],
    treeTotals: { ...totals },
    activeBranchTotals: { ...totals },
  };
}

function promptTokens(totals: CacheUsageTotals): number {
  return totals.input + totals.cacheRead + totals.cacheWrite;
}

function hitRate(totals: CacheUsageTotals): number {
  const denominator = promptTokens(totals);
  return denominator <= 0 ? 0 : (totals.cacheRead / denominator) * 100;
}

function formatInt(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    Math.round(value),
  );
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function buildChartData(
  values: number[],
  scale: ChartScale,
): ChartPoint[] {
  if (values.length === 0) return [];
  return values.map((value, index) => ({
    x:
      values.length === 1
        ? (CHART_LEFT + CHART_RIGHT) / 2
        : CHART_LEFT +
          (index / (values.length - 1)) * (CHART_RIGHT - CHART_LEFT),
    y: chartY(value, scale),
    value,
  }));
}

function chartValueScale(values: number[], view: ChartView): ChartScale {
  if (view !== "cumulative-total") {
    return { min: 0, max: 100, span: 100 };
  }

  const max = niceCeil(Math.max(1, ...values));
  return { min: 0, max, span: max };
}

function chartY(value: number, scale: ChartScale): number {
  return (
    CHART_BOTTOM -
    ((value - scale.min) / scale.span) * (CHART_BOTTOM - CHART_TOP)
  );
}

function buildChartTicks(scale: ChartScale, view: ChartView): ChartTick[] {
  const values =
    view === "cumulative-total"
      ? [0, scale.max * 0.25, scale.max * 0.5, scale.max * 0.75, scale.max]
      : [0, 25, 50, 75, 100];

  return values.map((value) => ({
    y: chartY(value, scale),
    value,
    label: formatChartValue(value, view),
  }));
}

function chartValues(rows: AssistantUsageMetric[], view: ChartView): number[] {
  if (view === "per-turn") return rows.map((row) => row.cacheHitPercent);

  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  return rows.map((row) => {
    input += row.input;
    cacheRead += row.cacheRead;
    cacheWrite += row.cacheWrite;
    if (view === "cumulative-total") return input + cacheRead + cacheWrite;
    const denominator = input + cacheRead + cacheWrite;
    return denominator <= 0 ? 0 : (cacheRead / denominator) * 100;
  });
}

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const multiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude;
}

function formatCompactInt(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: "compact",
  }).format(Math.round(value));
}

function formatChartValue(value: number, view: ChartView): string {
  if (view === "cumulative-total") return formatCompactInt(value);
  return `${Math.round(value)}%`;
}

function sessionPathLabel(row: AssistantUsageMetric): string {
  return row.isOnActiveBranch ? "current path" : "other path";
}

function chartLabel(view: ChartView): string {
  if (view === "per-turn") return "Per-turn cache hit %";
  if (view === "cumulative-percent") return "Cumulative cache hit %";
  return "Cumulative prompt tokens";
}
</script>

<header class="topbar">
  <div>
    <p class="eyebrow">Pi Context Cache</p>
    <h1>Cache Graph Dashboard</h1>
  </div>
  <div class="actions">
    <span class="updated">Updated {lastUpdated}</span>
    <button type="button" onclick={refresh}>Refresh</button>
    <button type="button" onclick={exportCsv}>Export CSV</button>
  </div>
</header>

<section class="cards">
  <article class="card primary">
    <span>Current path hit rate</span>
    <strong>{formatPercent(hitRate(metrics.activeBranchTotals))}</strong>
    <small>{formatInt(metrics.activeBranchTotals.assistantMessages)} turns</small>
  </article>
  <article class="card">
    <span>Current path tokens</span>
    <strong>{formatInt(promptTokens(metrics.activeBranchTotals))}</strong>
    <small>{formatInt(metrics.activeBranchTotals.cacheRead)} cache read</small>
  </article>
  <article class="card">
    <span>All paths hit rate</span>
    <strong>{formatPercent(hitRate(metrics.treeTotals))}</strong>
    <small>{formatInt(metrics.treeTotals.assistantMessages)} turns</small>
  </article>
  <article class="card">
    <span>Total tokens</span>
    <strong>{formatInt(metrics.treeTotals.totalTokens)}</strong>
    <small>{formatInt(metrics.treeTotals.output)} output</small>
  </article>
</section>

{#if statusMessage}
  <div class:error={status === "error"} class:success={status === "success"} class="banner">
    {statusMessage}
  </div>
{/if}

<main class:stats-focused={initialView === "stats"} class="dashboard">
  <section class="panel chart-panel">
    <div class="panel-header">
      <div>
        <p class="eyebrow">Trend</p>
        <h2>{chartLabel(chartView)}</h2>
      </div>
      <div class="select-wrap">
        <select aria-label="Chart metric" bind:value={chartView}>
          <option value="per-turn">Per-turn %</option>
          <option value="cumulative-percent">Cumulative %</option>
          <option value="cumulative-total">Token totals</option>
        </select>
      </div>
    </div>

    {#if chartRows.length === 0}
      <div class="empty">
        <span>No assistant usage metrics yet.</span>
        <small>
          boot {bootRows} · bridge {bridgeReady ? "ready" : "missing"} · refresh {refreshAttempts}/{refreshResponses}
        </small>
      </div>
    {:else}
      <svg class="chart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} role="img" aria-label={`${chartLabel(chartView)} over ${chartRows.length} messages`}>
        {#each chartTicks as tick}
          <g class="tick">
            <line x1={CHART_LEFT} y1={tick.y} x2={CHART_RIGHT} y2={tick.y} class="grid" />
            <text x={CHART_LEFT - 10} y={tick.y} class="tick-label">{tick.label}</text>
          </g>
        {/each}
        <line x1={CHART_LEFT} y1={CHART_BOTTOM} x2={CHART_RIGHT} y2={CHART_BOTTOM} class="axis" />
        <line x1={CHART_LEFT} y1={CHART_TOP} x2={CHART_LEFT} y2={CHART_BOTTOM} class="axis" />
        <polyline points={chartPolyline} class="line" />
        {#each chartData as point, index}
          <circle
            class="point"
            cx={point.x}
            cy={point.y}
            r="4"
          >
            <title>Turn {chartRows[index].sequence}: {formatChartValue(point.value, chartView)}</title>
          </circle>
        {/each}
      </svg>
    {/if}
  </section>

  <section class="panel table-panel">
    <div class="panel-header">
      <div>
        <p class="eyebrow">Stats</p>
        <h2>Assistant messages</h2>
      </div>
      <span>{metrics.allMessages.length} rows</span>
    </div>
    <div class="table-wrap">
      <table class:has-other-paths={hasOtherPaths}>
        <thead>
          <tr>
            <th>#</th>
            {#if hasOtherPaths}
              <th>Path</th>
            {/if}
            <th>Model</th>
            <th>Prompt</th>
            <th>Cache read</th>
            <th>Cache write</th>
            <th>Hit %</th>
          </tr>
        </thead>
        <tbody>
          {#each metrics.allMessages as row}
            <tr class:muted={!row.isOnActiveBranch}>
              <td>{row.sequence}</td>
              {#if hasOtherPaths}
                <td>{sessionPathLabel(row)}</td>
              {/if}
              <td>{row.provider}/{row.model}</td>
              <td>{formatInt(row.input + row.cacheRead + row.cacheWrite)}</td>
              <td>{formatInt(row.cacheRead)}</td>
              <td>{formatInt(row.cacheWrite)}</td>
              <td>{formatPercent(row.cacheHitPercent)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if metrics.allMessages.length === 0}
        <div class="empty table-empty">
          <span>No rows to display.</span>
          <small>
            boot {bootRows} · bridge {bridgeReady ? "ready" : "missing"} · refresh {refreshAttempts}/{refreshResponses}
          </small>
        </div>
      {/if}
    </div>
  </section>
</main>
