<script lang="ts">
type LogLine = { timestamp?: string; level?: string; message: string };

let { lines = [] }: { lines?: LogLine[] } = $props();

const levelColors: Record<string, string> = {
  info: "#60a5fa",
  warn: "#f59e0b",
  error: "#ef4444",
  debug: "#94a3b8",
};
</script>

<div class="va-log">
  {#each lines as line}
    <div class="va-log-line">
      {#if line.timestamp}
        <span class="va-log-ts">{line.timestamp}</span>
      {/if}
      {#if line.level}
        <span
          class="va-log-level"
          style="color: {levelColors[line.level] ?? '#94a3b8'}"
        >{line.level}</span>
      {/if}
      <span class="va-log-msg">{line.message}</span>
    </div>
  {/each}
</div>

<style>
  .va-log {
    margin: 12px 0;
    padding: 10px;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.7;
  }

  .va-log-line {
    display: flex;
    gap: 8px;
    padding: 1px 0;
  }

  .va-log-ts {
    color: #475569;
    white-space: nowrap;
  }

  .va-log-level {
    font-weight: 600;
    min-width: 40px;
    text-transform: uppercase;
  }

  .va-log-msg {
    color: #e2e8f0;
    word-break: break-all;
  }
</style>
