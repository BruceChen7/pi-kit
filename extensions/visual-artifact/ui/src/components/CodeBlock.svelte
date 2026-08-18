<script lang="ts">
import { cn } from "$lib/utils";

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
  {#if showLineNumbers}
    <div class="m-0 p-4 bg-primary text-primary-foreground font-mono text-sm leading-relaxed overflow-x-auto">
      <code class="table min-w-full border-collapse">
        {#each lines as line, i}
          <span class="table-row">
            <span class="table-cell w-8 text-right pr-4 select-none text-muted-foreground/60">{i + 1}</span>
            <span class="table-cell whitespace-pre">{line}</span>
          </span>
        {/each}
      </code>
    </div>
  {:else}
    <pre class="m-0 p-4 bg-primary text-primary-foreground font-mono text-sm leading-relaxed overflow-x-auto"><code class="block whitespace-pre">{code}</code></pre>
  {/if}
</div>
