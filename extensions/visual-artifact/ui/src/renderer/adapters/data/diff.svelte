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

<div class="rounded-xl border border-border overflow-hidden my-3">
  {#if language}
    <div class="px-3 py-1.5 bg-muted text-muted-foreground font-mono text-xs border-b border-border">{language}</div>
  {/if}
  <div class="grid grid-cols-2">
    <div class="overflow-x-auto border-r border-border">
      <div class="px-3 py-1 bg-[#141413] text-[#6b6a63] text-[10px] font-semibold uppercase tracking-wider border-b border-border">Before</div>
      {#each { length: maxLines } as _, i}
        {@const beforeLine = beforeLines[i] ?? ""}
        {@const afterLine = afterLines[i] ?? ""}
        <pre class="m-0 px-3 py-0.5 text-xs font-mono leading-relaxed whitespace-pre {afterLine !== '' && beforeLine !== afterLine ? 'bg-rust/20 text-rust' : beforeLines[i] === undefined ? 'text-transparent' : 'text-[#f0eee6]'}">{beforeLine || " "}</pre>
      {/each}
    </div>
    <div class="overflow-x-auto">
      <div class="px-3 py-1 bg-[#141413] text-[#6b6a63] text-[10px] font-semibold uppercase tracking-wider border-b border-border">After</div>
      {#each { length: maxLines } as _, i}
        {@const beforeLine = beforeLines[i] ?? ""}
        {@const afterLine = afterLines[i] ?? ""}
        <pre class="m-0 px-3 py-0.5 text-xs font-mono leading-relaxed whitespace-pre {beforeLine !== '' && beforeLine !== afterLine ? 'bg-olive/20 text-olive' : afterLines[i] === undefined ? 'text-transparent' : 'text-[#f0eee6]'}">{afterLine || " "}</pre>
      {/each}
    </div>
  </div>
</div>
