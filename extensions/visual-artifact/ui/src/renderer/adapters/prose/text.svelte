<script lang="ts">
import { renderInlineMarkdown } from "../../inline-markdown.ts";

let { text = "", size = "md" }: { text?: string; size?: string } = $props();

const sizeClasses: Record<string, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-base sm:text-lg",
  xl: "text-lg sm:text-xl",
};
</script>

<p class="va-text leading-[1.72] text-foreground whitespace-pre-wrap mb-4 {sizeClasses[size] ?? 'text-base'}">
  {@html renderInlineMarkdown(text)}
</p>
