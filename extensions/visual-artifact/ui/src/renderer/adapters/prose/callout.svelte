<script lang="ts">
import { cn } from "$lib/utils";
import { renderInlineMarkdown } from "../../inline-markdown.ts";

let {
  title = "",
  text = "",
  variant = "info",
}: { title?: string; text?: string; variant?: string } = $props();

const variantClasses: Record<string, string> = {
  info: "bg-clay/10 border-clay/20 text-clay-dark",
  success: "bg-olive/10 border-olive/20 text-olive-dark",
  warning: "bg-amber/10 border-amber/20 text-amber",
  danger: "bg-rust/10 border-rust/20 text-rust",
};
</script>

<div class={cn("px-4 py-3 my-3 rounded-lg border text-sm leading-relaxed", variantClasses[variant] ?? variantClasses.info)}>
  {#if title}
    <strong class="block mb-1">{@html renderInlineMarkdown(title)}</strong>
  {/if}
  {#if text}
    <div>{@html renderInlineMarkdown(text)}</div>
  {/if}
</div>
