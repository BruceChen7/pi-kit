<script lang="ts">
import VisualArtifactRenderer from "../../visual-artifact-renderer.svelte";

let {
  title = "",
  nodes = [],
  _nodePath = "",
}: {
  title?: string;
  nodes?: { type: string; props: Record<string, unknown> }[];
  _nodePath?: string;
} = $props();
</script>

<section class="my-4">
  {#if title}
    <h2 class="font-serif text-2xl font-medium tracking-[-0.02em] text-foreground pb-2 mb-3 border-b border-border">{title}</h2>
  {/if}
  <div>
    <VisualArtifactRenderer {nodes} basePath={`${_nodePath}.props.nodes`} />
  </div>
</section>
