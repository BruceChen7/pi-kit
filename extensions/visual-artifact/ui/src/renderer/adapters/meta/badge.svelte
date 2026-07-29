<script lang="ts">
let { text = "", variant = "default" }: { text?: string; variant?: string } =
  $props();
</script>

<Badge {variant}>
  {text}
</Badge>
