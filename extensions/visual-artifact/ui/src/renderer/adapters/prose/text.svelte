<script lang="ts">
let { text = "", size = "md" }: { text?: string; size?: string } = $props();

const sizeMap: Record<string, string> = {
  sm: "13px",
  md: "15px",
  lg: "18px",
  xl: "22px",
};

const fontSize = $derived(sizeMap[size] ?? sizeMap.md);
</script>

<p class="va-text" style="font-size: {fontSize}">{text}</p>

<style>
  .va-text {
    margin: 0 0 12px;
    line-height: 1.65;
    color: #e2e8f0;
    white-space: pre-wrap;
  }
</style>
