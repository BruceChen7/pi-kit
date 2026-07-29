<script lang="ts">
let {
  src = "",
  poster = "",
  caption = "",
}: { src?: string; poster?: string; caption?: string } = $props();
</script>

<figure class="my-3 text-center">
  <video controls {poster} preload="metadata" class="max-w-full rounded-xl border border-border">
    <source {src} />
  </video>
  {#if caption}
    <figcaption class="mt-1.5 text-xs text-muted-foreground">{caption}</figcaption>
  {/if}
</figure>
