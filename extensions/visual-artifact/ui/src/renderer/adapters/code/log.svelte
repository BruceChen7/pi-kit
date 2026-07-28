<script lang="ts">
type LogLine = { timestamp?: string; level?: string; message: string };

let { lines = [] }: { lines?: LogLine[] } = $props();

const levelColors: Record<string, string> = {
  info: "var(--va-accent-primary-text)",
  warn: "var(--va-accent-warning)",
  error: "var(--va-accent-danger)",
  debug: "var(--va-accent-neutral)",
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
          style="color: {levelColors[line.level] ?? 'var(--va-accent-neutral)'}"
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
    background: var(--va-bg-code);
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
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
    color: var(--va-text-subtle);
    white-space: nowrap;
  }

  .va-log-level {
    font-weight: 600;
    min-width: 40px;
    text-transform: uppercase;
  }

  .va-log-msg {
    color: var(--va-text-secondary);
    word-break: break-all;
  }
</style>
