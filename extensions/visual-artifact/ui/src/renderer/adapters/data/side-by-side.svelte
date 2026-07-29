<script lang="ts">
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  left = [],
  right = [],
  leftLabel = "",
  rightLabel = "",
  _nodePath = "",
}: {
  left?: { type: string; props: Record<string, unknown> }[];
  right?: { type: string; props: Record<string, unknown> }[];
  leftLabel?: string;
  rightLabel?: string;
  _nodePath?: string;
} = $props();
</script>

<div class="grid grid-cols-1 sm:grid-cols-2 my-3 rounded-xl border border-border overflow-hidden">
  <div class="min-w-0 break-words border-b sm:border-b-0 sm:border-r border-border bg-rust/[0.02]">
    {#if leftLabel}
      <div class="px-3 py-1.5 bg-[#141413] text-rust text-[10px] font-semibold uppercase tracking-wider border-b border-border">{leftLabel}</div>
    {/if}
    <div class="p-3 min-w-0 break-words">
      <VisualArtifactRenderer nodes={left} basePath={`${_nodePath}.props.left`} />
    </div>
  </div>
  <div class="min-w-0 break-words bg-olive/[0.02]">
    {#if rightLabel}
      <div class="px-3 py-1.5 bg-[#141413] text-olive text-[10px] font-semibold uppercase tracking-wider border-b border-border">{rightLabel}</div>
    {/if}
    <div class="p-3 min-w-0 break-words">
      <VisualArtifactRenderer nodes={right} basePath={`${_nodePath}.props.right`} />
    </div>
  </div>
</div>
