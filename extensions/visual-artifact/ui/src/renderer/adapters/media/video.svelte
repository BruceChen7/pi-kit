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
    border-radius: 8px;
    border: 1px solid #334155;
  }

  figcaption {
    margin-top: 6px;
    color: #64748b;
    font-size: 12px;
  }
</style>
