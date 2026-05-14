<script lang="ts">
import {
  buildRepoOptions,
  filterRowsForGraph,
  formatDateInputValue,
  totalsForRows,
  type ChartRange,
  type RepoFilter,
} from "../../chart-filters.ts";

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
  repoSlug: string;
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

type ChartView = "per-turn" | "cumulative-percent" | "cumulative-total";
type Status = "idle" | "loading" | "error" | "success";

type ChartPoint = {
  x: number;
  y: number;
  width: number;
  value: number;
  sourceStart: number;
  sourceEnd: number;
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

type ChartTimeLabels = {
  start: string;
  end: string;
};

type BootData = {
  metrics: CacheSessionMetrics;
};

type DashboardResult =
  | { type: "metrics"; ok: true; metrics: CacheSessionMetrics }
  | { type: "export-result"; ok: true; filePath: string }
  | { type: "error"; ok: false; action: "refresh" | "export"; message: string };

const CHART_WIDTH = 640;
const CHART_HEIGHT = 236;
const CHART_TOP = 22;
const CHART_RIGHT = 618;
const CHART_BOTTOM = 192;
const CHART_LEFT = 62;
const CHART_TIME_LABEL_Y = 210;
const MAX_CHART_BARS = 72;
const CHART_MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

declare global {
  interface Window {
    __CACHE_GRAPH_BOOT__?: BootData;
    glimpse?: {
      send(message: unknown): void;
      close(): void;
    };
  }
}

const boot = window.__CACHE_GRAPH_BOOT__ ?? {
  metrics: emptyMetrics(),
};
const bootRows = boot.metrics.allMessages.length;

let metrics = $state<CacheSessionMetrics>(boot.metrics);
let chartView = $state<ChartView>("per-turn");
let chartRange = $state<ChartRange>("today");
let selectedRepo = $state<RepoFilter>("all");
let selectedDate = $state(formatDateInputValue(new Date()));
let status = $state<Status>("idle");
let statusMessage = $state("");
let lastUpdated = $state(new Date().toLocaleTimeString());
let silentRefreshPending = false;
let didRequestInitialRefresh = false;
let statusDismissTimer: ReturnType<typeof window.setTimeout> | null = null;
let bridgeReady = $state(typeof window.glimpse?.send === "function");
let refreshAttempts = $state(0);
let refreshResponses = $state(0);

const repoOptions = $derived(buildRepoOptions(metrics.allMessages));
const chartRows = $derived(
  filterRowsForGraph(metrics.allMessages, {
    repo: selectedRepo,
    anchorDate: selectedDate,
    range: chartRange,
  }),
);
const selectedTotals = $derived(totalsForRows(chartRows));
const chartValuesForView = $derived(chartValues(chartRows, chartView));
const chartScale = $derived(chartValueScale(chartValuesForView, chartView));
const chartTicks = $derived(buildChartTicks(chartScale, chartView));
const chartData = $derived(
  buildChartData(chartValuesForView, chartScale, chartView),
);
const chartTimeLabels = $derived(buildChartTimeLabels(chartRows));

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

function handleCloseShortcut(event: KeyboardEvent): void {
  if (!event.metaKey || event.key.toLowerCase() !== "w") return;
  event.preventDefault();
  window.glimpse?.close();
}

$effect(() => {
  window.addEventListener("keydown", handleCloseShortcut);
  return () => window.removeEventListener("keydown", handleCloseShortcut);
});

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
  view: ChartView,
): ChartPoint[] {
  if (values.length === 0) return [];
  const barCount = Math.min(values.length, MAX_CHART_BARS);
  const slotWidth = (CHART_RIGHT - CHART_LEFT) / barCount;
  const gap = slotWidth < 4 ? 0.75 : slotWidth < 8 ? 1.25 : 2;
  const width = Math.max(1, slotWidth - gap);

  return Array.from({ length: barCount }, (_, index) => {
    const sourceStart = Math.floor((index * values.length) / barCount);
    const sourceEnd = Math.max(
      sourceStart,
      Math.floor(((index + 1) * values.length) / barCount) - 1,
    );
    const sourceValues = values.slice(sourceStart, sourceEnd + 1);
    const value =
      view === "per-turn"
        ? average(sourceValues)
        : (sourceValues[sourceValues.length - 1] ?? 0);

    return {
      x: CHART_LEFT + slotWidth * index + gap / 2,
      y: chartY(value, scale),
      width,
      value,
      sourceStart,
      sourceEnd,
    };
  });
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function chartBarHeight(point: ChartPoint): number {
  if (point.value <= 0) return 0;
  return Math.max(1, CHART_BOTTOM - point.y);
}

function chartBarY(point: ChartPoint): number {
  return CHART_BOTTOM - chartBarHeight(point);
}

function chartBarTitle(
  point: ChartPoint,
  rows: AssistantUsageMetric[],
  view: ChartView,
): string {
  const first = rows[point.sourceStart];
  const last = rows[point.sourceEnd] ?? first;
  if (!first) return formatChartValue(point.value, view);
  const turnLabel =
    first === last
      ? `Turn ${first.sequence}`
      : `Turns ${first.sequence}-${last.sequence}`;
  return `${first.repoSlug} · ${turnLabel}: ${formatChartValue(point.value, view)}`;
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

function buildChartTimeLabels(
  rows: AssistantUsageMetric[],
): ChartTimeLabels | null {
  if (rows.length === 0) return null;

  const first = rows[0];
  const last = rows[rows.length - 1] ?? first;
  return {
    start: formatChartTimestamp(first.timestamp),
    end: formatChartTimestamp(last.timestamp),
  };
}

function formatChartTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp.slice(0, 19);
  }

  const month = CHART_MONTH_LABELS[date.getMonth()] ?? "";
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(formatClockPart)
    .join(":");
  return `${month} ${date.getDate()} ${time}`;
}

function formatClockPart(value: number): string {
  return value.toString().padStart(2, "0");
}

function selectedRepoLabel(repo: RepoFilter): string {
  return repo === "all" ? "All repos" : repo;
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
    <span>Selected hit rate</span>
    <strong>{formatPercent(hitRate(selectedTotals))}</strong>
    <small>{formatInt(selectedTotals.assistantMessages)} turns · {selectedRepoLabel(selectedRepo)}</small>
  </article>
  <article class="card">
    <span>Selected prompt tokens</span>
    <strong>{formatInt(promptTokens(selectedTotals))}</strong>
    <small>{formatInt(selectedTotals.cacheRead)} cache read</small>
  </article>
  <article class="card">
    <span>All repos hit rate</span>
    <strong>{formatPercent(hitRate(metrics.treeTotals))}</strong>
    <small>{formatInt(metrics.treeTotals.assistantMessages)} turns</small>
  </article>
  <article class="card">
    <span>All repos tokens</span>
    <strong>{formatInt(metrics.treeTotals.totalTokens)}</strong>
    <small>{formatInt(metrics.treeTotals.output)} output</small>
  </article>
</section>

{#if statusMessage}
  <div class:error={status === "error"} class:success={status === "success"} class="banner">
    {statusMessage}
  </div>
{/if}

<main class="dashboard">
  <section class="panel chart-panel">
    <div class="panel-header">
      <div class="panel-title">
        <p class="eyebrow">Trend</p>
        <h2>{chartLabel(chartView)}</h2>
      </div>
      <div class="filter-bar">
        <label>
          <span>Repo</span>
          <select aria-label="Repository" bind:value={selectedRepo}>
            <option value="all">All repos</option>
            {#each repoOptions as repo}
              <option value={repo}>{repo}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>Date</span>
          <input aria-label="Chart date" type="date" bind:value={selectedDate} />
        </label>
        <label>
          <span>Range</span>
          <select aria-label="Date range" bind:value={chartRange}>
            <option value="today">Today</option>
            <option value="7d">7 days</option>
            <option value="1m">1 month</option>
          </select>
        </label>
        <label>
          <span>Metric</span>
          <select aria-label="Chart metric" bind:value={chartView}>
            <option value="per-turn">Per-turn %</option>
            <option value="cumulative-percent">Cumulative %</option>
            <option value="cumulative-total">Token totals</option>
          </select>
        </label>
      </div>
    </div>

    {#if chartRows.length === 0}
      <div class="empty">
        <span>No assistant usage metrics for this repo/date range.</span>
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
        {#if chartTimeLabels}
          <text
            x={CHART_LEFT}
            y={CHART_TIME_LABEL_Y}
            class="x-time-label x-time-label-start"
          >
            {chartTimeLabels.start}
          </text>
          <text
            x={CHART_RIGHT}
            y={CHART_TIME_LABEL_Y}
            class="x-time-label x-time-label-end"
          >
            {chartTimeLabels.end}
          </text>
        {/if}
        {#each chartData as point, index}
          <rect
            class:last-bar={index === chartData.length - 1}
            class="bar"
            x={point.x}
            y={chartBarY(point)}
            width={point.width}
            height={chartBarHeight(point)}
            rx="1.5"
          >
            <title>{chartBarTitle(point, chartRows, chartView)}</title>
          </rect>
        {/each}
      </svg>
    {/if}
  </section>
</main>
