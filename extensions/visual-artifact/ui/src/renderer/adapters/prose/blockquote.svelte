<script lang="ts">
let { text = "" }: { text?: string } = $props();
</script>

<blockquote class="my-3 pl-4 py-2 border-l-[3px] border-border text-muted-foreground italic leading-relaxed text-sm">
  {text}
</blockquote>
