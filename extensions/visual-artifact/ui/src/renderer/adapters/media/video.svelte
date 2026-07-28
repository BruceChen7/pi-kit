<script lang="ts">
let {
  src = "",
  poster = "",
  caption = "",
}: { src?: string; poster?: string; caption?: string } = $props();
</script>

<figure class="va-video">
  <video controls {poster} preload="metadata">
    <source {src} />
  </video>
  {#if caption}
    <figcaption>{caption}</figcaption>
  {/if}
</figure>

<style>
  .va-video {
    margin: 12px 0;
    text-align: center;
  }

  video {
    max-width: 100%;
    border-radius: var(--va-radius-md);
    border: 1px solid var(--va-border-default);
  }

  figcaption {
    margin-top: 6px;
    color: var(--va-text-subtle);
    font-size: 12px;
  }
</style>
