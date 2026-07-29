<script lang="ts">
type LogLine = { timestamp?: string; level?: string; message: string };

let { lines = [] }: { lines?: LogLine[] } = $props();

const levelColors: Record<string, string> = {
  info: "text-olive",
  warn: "text-[#d9a84b]",
  error: "text-rust",
  debug: "text-muted-foreground",
};
</script>

<div class="rounded-xl border border-border bg-[#141413] text-[#f0eee6] font-mono text-xs leading-relaxed p-3 my-3">
  {#each lines as line}
    <div class="flex gap-2 py-px">
      {#if line.timestamp}
        <span class="text-[#6b6a63] shrink-0">{line.timestamp}</span>
      {/if}
      {#if line.level}
        <span class="font-semibold min-w-[40px] uppercase {levelColors[line.level] ?? 'text-muted-foreground'}">{line.level}</span>
      {/if}
      <span class="text-[#f0eee6] break-all">{line.message}</span>
    </div>
  {/each}
</div>
