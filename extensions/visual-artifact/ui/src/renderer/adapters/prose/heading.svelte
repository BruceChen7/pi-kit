<script lang="ts">
let { text = "", level = "h2" }: { text?: string; level?: string } = $props();

const levelMap: Record<string, 1 | 2 | 3 | 4> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
};
</script>

<Heading level={levelMap[level] ?? 2}>
  {text}
</Heading>
