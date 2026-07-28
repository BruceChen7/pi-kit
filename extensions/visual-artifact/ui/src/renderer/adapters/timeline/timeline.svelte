<script lang="ts">
type TimelineEvent = {
  date?: string;
  title: string;
  description?: string;
};

let { events = [] }: { events?: TimelineEvent[] } = $props();
</script>

{#if events.length > 0}
  <div class="va-timeline">
    {#each events as event, i}
      <div class="va-tl-item">
        <div class="va-tl-marker">
          <span class="va-tl-dot" class:va-tl-dot-last={i === events.length - 1}></span>
          {#if i < events.length - 1}
            <span class="va-tl-line"></span>
          {/if}
        </div>
        <div class="va-tl-content">
          {#if event.date}
            <p class="va-tl-date">{event.date}</p>
          {/if}
          <p class="va-tl-title">{event.title}</p>
          {#if event.description}
            <p class="va-tl-desc">{event.description}</p>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .va-timeline {
    margin: 16px 0;
  }

  .va-tl-item {
    display: flex;
    gap: 12px;
    min-height: 48px;
  }

  .va-tl-marker {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 16px;
    flex-shrink: 0;
  }

  .va-tl-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--va-accent-primary);
    border: 2px solid var(--va-bg-surface);
    flex-shrink: 0;
    margin-top: 4px;
  }

  .va-tl-dot-last {
    background: var(--va-accent-success);
  }

  .va-tl-line {
    width: 2px;
    flex: 1;
    background: var(--va-border-default);
    margin: 2px 0;
  }

  .va-tl-content {
    padding-bottom: 16px;
    min-width: 0;
  }

  .va-tl-date {
    margin: 0 0 2px;
    color: var(--va-text-subtle);
    font-size: 11px;
    font-family: monospace;
  }

  .va-tl-title {
    margin: 0;
    color: var(--va-text-primary);
    font-size: 14px;
    font-weight: 600;
  }

  .va-tl-desc {
    margin: 4px 0 0;
    color: var(--va-text-muted);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
