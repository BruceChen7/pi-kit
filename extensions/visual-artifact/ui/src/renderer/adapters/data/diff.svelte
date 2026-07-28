<script lang="ts">
let {
  before = "",
  after = "",
  language = "",
}: { before?: string; after?: string; language?: string } = $props();

const beforeLines = $derived(before.split("\n"));
const afterLines = $derived(after.split("\n"));
const maxLines = $derived(Math.max(beforeLines.length, afterLines.length));
</script>

<div class="va-diff">
  {#if language}
    <p class="va-diff-lang">{language}</p>
  {/if}
  <div class="va-diff-grid">
    <div class="va-diff-panel">
      <p class="va-diff-panel-label">Before</p>
      {#each { length: maxLines } as _, i}
        {@const beforeLine = beforeLines[i] ?? ""}
        {@const afterLine = afterLines[i] ?? ""}
        <pre
          class:va-diff-removed={afterLine !== "" && beforeLine !== afterLine}
          class:va-diff-empty={!beforeLines[i]}
        >{beforeLine || " "}</pre>
      {/each}
    </div>
    <div class="va-diff-panel">
      <p class="va-diff-panel-label">After</p>
      {#each { length: maxLines } as _, i}
        {@const beforeLine = beforeLines[i] ?? ""}
        {@const afterLine = afterLines[i] ?? ""}
        <pre
          class:va-diff-added={beforeLine !== "" && beforeLine !== afterLine}
          class:va-diff-empty={!afterLines[i]}
        >{afterLine || " "}</pre>
      {/each}
    </div>
  </div>
</div>

<style>
  .va-diff {
    margin: 12px 0;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    overflow: hidden;
  }

  .va-diff-lang {
    margin: 0;
    padding: 6px 12px;
    background: var(--va-bg-surface);
    color: var(--va-text-subtle);
    font-size: 11px;
    font-family: monospace;
    border-bottom: 1px solid var(--va-border-default);
  }

  .va-diff-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .va-diff-panel {
    overflow-x: auto;
  }

  .va-diff-panel:first-child {
    border-right: 1px solid var(--va-border-default);
  }

  .va-diff-panel-label {
    margin: 0;
    padding: 4px 10px;
    background: var(--va-bg-code);
    color: var(--va-text-subtle);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--va-border-default);
  }

  pre {
    margin: 0;
    padding: 2px 10px;
    font-size: 12px;
    font-family: monospace;
    line-height: 1.5;
    color: var(--va-text-secondary);
    white-space: pre;
  }

  .va-diff-removed {
    background: var(--va-bg-danger-subtle);
    color: var(--va-accent-danger-text);
  }

  .va-diff-added {
    background: var(--va-bg-success-subtle);
    color: var(--va-accent-success-text);
  }

  .va-diff-empty {
    color: transparent;
  }
</style>
