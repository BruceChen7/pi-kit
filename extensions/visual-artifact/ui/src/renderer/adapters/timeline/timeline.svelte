<script lang="ts">
type TimelineEvent = {
  date?: string;
  title: string;
  description?: string;
};

let { events = [] }: { events?: TimelineEvent[] } = $props();
</script>

{#if events.length > 0}
  <div class="my-4">
    {#each events as event, i}
      <div class="flex gap-3 min-h-[48px]">
        <div class="flex flex-col items-center w-4 shrink-0">
          <span class="w-2.5 h-2.5 rounded-full bg-clay border-2 border-card shrink-0 mt-1 {i === events.length - 1 ? 'bg-olive' : ''}"></span>
          {#if i < events.length - 1}
            <span class="w-0.5 flex-1 my-0.5 bg-border"></span>
          {/if}
        </div>
        <div class="pb-4 min-w-0">
          {#if event.date}
            <p class="text-[11px] font-mono text-muted-foreground/70 mb-0.5">{event.date}</p>
          {/if}
          <p class="text-sm font-semibold text-foreground">{event.title}</p>
          {#if event.description}
            <p class="text-xs text-muted-foreground leading-relaxed mt-1">{event.description}</p>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
