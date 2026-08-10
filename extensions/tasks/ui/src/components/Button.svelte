<script lang="ts">
import type { Snippet } from "svelte";

type Variant = "secondary" | "primary" | "danger";
type Size = "default" | "sm";

interface Props {
  children?: Snippet;
  variant?: Variant;
  size?: Size;
  class?: string;
  [key: string]: unknown;
}

let {
  children,
  variant = "secondary",
  size = "default",
  class: className = "",
  ...rest
}: Props = $props();

const variants: Record<Variant, string> = {
  secondary:
    "border-[#2d3039] bg-transparent text-[#9ca3af] hover:bg-[#1c1f26] hover:text-[#e5e7eb]",
  primary: "border-indigo-500 bg-indigo-500 text-white hover:bg-[#4f52e0]",
  danger: "border-red-950 bg-[#2a1215] text-red-400 hover:bg-[#40171b]",
};

const sizes: Record<Size, string> = {
  default: "px-3 py-1.25 text-xs",
  sm: "px-2 py-0.75 text-[11px]",
};
</script>

<button
  class={`inline-flex cursor-pointer items-center justify-center rounded-md border [font:inherit] transition-colors duration-150 ${variants[variant]} ${sizes[size]} ${className}`}
  {...rest}
>
  {@render children?.()}
</button>
