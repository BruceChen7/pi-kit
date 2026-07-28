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
    border: 1px solid #334155;
    border-radius: 8px;
    overflow: hidden;
  }

  .va-diff-lang {
    margin: 0;
    padding: 6px 12px;
    background: #1e293b;
    color: #64748b;
    font-size: 11px;
    font-family: monospace;
    border-bottom: 1px solid #334155;
  }

  .va-diff-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .va-diff-panel {
    overflow-x: auto;
  }

  .va-diff-panel:first-child {
    border-right: 1px solid #334155;
  }

  .va-diff-panel-label {
    margin: 0;
    padding: 4px 10px;
    background: #0f172a;
    color: #64748b;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #334155;
  }

  pre {
    margin: 0;
    padding: 2px 10px;
    font-size: 12px;
    font-family: monospace;
    line-height: 1.5;
    color: #cbd5e1;
    white-space: pre;
  }

  .va-diff-removed {
    background: rgba(239, 68, 68, 0.08);
    color: #fca5a5;
  }

  .va-diff-added {
    background: rgba(34, 197, 94, 0.08);
    color: #86efac;
  }

  .va-diff-empty {
    color: transparent;
  }
</style>
