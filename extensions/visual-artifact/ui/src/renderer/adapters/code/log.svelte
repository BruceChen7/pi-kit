<script lang="ts">
type LogLine = { timestamp?: string; level?: string; message: string };

let { lines = [] }: { lines?: LogLine[] } = $props();

const levelColors: Record<string, string> = {
  info: "text-olive",
  warn: "text-amber",
  error: "text-rust",
  debug: "text-muted-foreground",
};
</script>

<div class="rounded-xl border border-border bg-primary text-primary-foreground font-mono text-xs leading-relaxed p-3 my-3">
  {#each lines as line}
    <div class="flex gap-2 py-px">
      {#if line.timestamp}
        <span class="text-muted-foreground shrink-0">{line.timestamp}</span>
      {/if}
      {#if line.level}
        <span class="font-semibold min-w-[40px] uppercase {levelColors[line.level] ?? 'text-muted-foreground'}">{line.level}</span>
      {/if}
      <span class="text-primary-foreground break-all">{line.message}</span>
    </div>
  {/each}
</div>
