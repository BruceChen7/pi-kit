<script lang="ts">
import { renderInlineMarkdown } from "../../inline-markdown.ts";

let { text = "", size = "md" }: { text?: string; size?: string } = $props();

const sizeClasses: Record<string, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-xl",
};
</script>

<p class="leading-relaxed text-foreground whitespace-pre-wrap mb-3 {sizeClasses[size] ?? 'text-base'}">
  {@html renderInlineMarkdown(text)}
</p>
