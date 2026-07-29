<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template
import { renderInlineMarkdown } from "../../inline-markdown.ts";

let { text = "", size = "md" }: { text?: string; size?: string } = $props();

const sizeMap: Record<string, string> = {
  sm: "13px",
  md: "15px",
  lg: "18px",
  xl: "22px",
};

const fontSize = $derived(sizeMap[size] ?? sizeMap.md);
</script>

<p class="va-text" style="font-size: {fontSize}">
  {@html renderInlineMarkdown(text)}
</p>

<style>
  .va-text {
    margin: 0 0 12px;
    line-height: 1.65;
    color: var(--va-text-secondary);
    white-space: pre-wrap;
  }

  .va-text :global(code) {
    padding: 0.12em 0.38em;
    border: 1px solid var(--va-border-default);
    border-radius: 4px;
    background: var(--va-bg-code);
    color: var(--va-accent-primary-text);
    font-family: var(--va-font-mono);
    font-size: 0.88em;
  }

  .va-text :global(strong) {
    color: var(--va-text-primary);
    font-weight: 700;
  }
</style>
