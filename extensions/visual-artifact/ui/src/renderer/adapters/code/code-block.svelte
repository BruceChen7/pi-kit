<script lang="ts">
let {
  code = "",
  language = "",
  showLineNumbers = false,
}: { code?: string; language?: string; showLineNumbers?: boolean } = $props();

const lines = $derived(code.split("\n"));
</script>

<div class="va-code-block">
  {#if language}
    <div class="va-code-lang">{language}</div>
  {/if}
  <pre class="va-code-pre">
    {#if showLineNumbers}
      {#each lines as line, i}
        <code><span class="va-line-num">{i + 1}</span> {line}</code>
      {/each}
    {:else}
      <code>{code}</code>
    {/if}
  </pre>
</div>

<style>
  .va-code-block {
    margin: 12px 0;
    border: 1px solid #334155;
    border-radius: 8px;
    overflow: hidden;
  }

  .va-code-lang {
    padding: 4px 12px;
    background: #1e293b;
    color: #64748b;
    font-size: 11px;
    font-family: monospace;
    border-bottom: 1px solid #334155;
  }

  .va-code-pre {
    margin: 0;
    padding: 12px;
    background: #0f172a;
    font-family: monospace;
    font-size: 13px;
    line-height: 1.6;
    overflow-x: auto;
  }

  code {
    color: #e2e8f0;
    white-space: pre;
  }

  .va-line-num {
    display: inline-block;
    width: 32px;
    color: #475569;
    user-select: none;
    text-align: right;
    padding-right: 12px;
  }
</style>
