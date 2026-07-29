<script lang="ts">
import Badge from "$components/Badge.svelte";

let { text = "", variant = "default" }: { text?: string; variant?: string } =
  $props();
</script>

<Badge {variant}>
  {text}
</Badge>
