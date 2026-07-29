<script lang="ts">
let { text = "", attribution = "" }: { text?: string; attribution?: string } =
  $props();
</script>

<figure class="my-3 pl-4 py-3 border-l-[3px] border-clay bg-clay/5 rounded-r-lg">
  <blockquote class="m-0 italic text-foreground leading-relaxed">{text}</blockquote>
  {#if attribution}
    <figcaption class="mt-1.5 text-xs text-muted-foreground">— {attribution}</figcaption>
  {/if}
</figure>
