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
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    overflow: hidden;
  }

  .va-code-lang {
    padding: 4px 12px;
    background: var(--va-bg-surface);
    color: var(--va-text-subtle);
    font-size: 11px;
    font-family: monospace;
    border-bottom: 1px solid var(--va-border-default);
  }

  .va-code-pre {
    margin: 0;
    padding: 12px;
    background: var(--va-bg-code);
    font-family: monospace;
    font-size: 13px;
    line-height: 1.6;
    overflow-x: auto;
  }

  code {
    color: var(--va-text-secondary);
    white-space: pre;
  }

  .va-line-num {
    display: inline-block;
    width: 32px;
    color: var(--va-text-subtle);
    user-select: none;
    text-align: right;
    padding-right: 12px;
  }
</style>
