<script lang="ts">
let {
  src = "",
  alt = "",
  caption = "",
}: { src?: string; alt?: string; caption?: string } = $props();
</script>

<figure class="my-3 text-center">
  <img {src} {alt} loading="lazy" class="max-w-full h-auto rounded-xl border border-border" />
  {#if caption}
    <figcaption class="mt-1.5 text-xs text-muted-foreground">{caption}</figcaption>
  {/if}
</figure>
