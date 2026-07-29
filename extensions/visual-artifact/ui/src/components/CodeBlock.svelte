<script lang="ts">
let {
  code = "",
  language = "",
  showLineNumbers = false,
  class: className = "",
}: {
  code?: string;
  language?: string;
  showLineNumbers?: boolean;
  class?: string;
} = $props();

const lines = $derived(code.split("\n"));
</script>

<div class={cn("rounded-xl border border-border overflow-hidden", className)}>
  {#if language}
    <div class="flex items-center justify-between px-4 py-2 bg-muted text-xs text-muted-foreground border-b border-border font-mono">
      {language}
    </div>
  {/if}
  <pre class="m-0 p-4 bg-[#141413] text-[#f0eee6] font-mono text-sm leading-relaxed overflow-x-auto">
    {#if showLineNumbers}
      {#each lines as line, i}
        <code class="table-row">
          <span class="table-cell w-8 text-right pr-4 select-none text-[#6b6a63]/40">{i + 1}</span>
          <span class="table-cell whitespace-pre">{line}</span>
        </code>
      {/each}
    {:else}
      <code class="whitespace-pre">{code}</code>
    {/if}
  </pre>
</div>
