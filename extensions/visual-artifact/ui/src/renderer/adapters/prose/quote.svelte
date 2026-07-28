<script lang="ts">
let { text = "", attribution = "" }: { text?: string; attribution?: string } =
  $props();
</script>

<figure class="va-quote">
  <blockquote>{text}</blockquote>
  {#if attribution}
    <figcaption>— {attribution}</figcaption>
  {/if}
</figure>

<style>
  .va-quote {
    margin: 12px 0;
    padding: 12px 16px;
    border-left: 3px solid var(--va-accent-primary);
    background: var(--va-bg-info-subtle);
    border-radius: 0 6px 6px 0;
  }

  blockquote {
    margin: 0;
    font-style: italic;
    color: var(--va-text-secondary);
    line-height: 1.6;
  }

  figcaption {
    margin-top: 6px;
    color: var(--va-text-subtle);
    font-size: 12px;
  }
</style>
