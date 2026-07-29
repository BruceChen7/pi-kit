<script lang="ts">
let { text = "", variant = "info" }: { text?: string; variant?: string } =
  $props();

const variantClasses: Record<string, string> = {
  info: "bg-clay/10 border-clay/20 text-clay-dark",
  success: "bg-olive/10 border-olive/20 text-olive",
  warning: "bg-[#d9a84b]/10 border-[#d9a84b]/20 text-[#b88a30]",
  danger: "bg-rust/10 border-rust/20 text-rust",
};
</script>

<div class={cn("px-4 py-3 my-3 rounded-lg border text-sm leading-relaxed", variantClasses[variant] ?? variantClasses.info)}>
  {text}
</div>
