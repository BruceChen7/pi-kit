<script lang="ts">
// biome-ignore lint/correctness/noUnusedImports: used in template as <Adapter>
import { getAdapter } from "./component-registry.ts";

type ArtifactNode = {
  type: string;
  props: Record<string, unknown>;
  metadata?: { id?: string; label?: string };
};

let { nodes }: { nodes: ArtifactNode[] } = $props();

function nodeId(node: ArtifactNode, index: number): string {
  return node.metadata?.id ?? `node-${index}`;
}

function fallbackMessage(type: string): string {
  return `[Unsupported node type: "${type}"]`;
}
</script>

{#each nodes as node, i (nodeId(node, i))}
  {@const Adapter = getAdapter(node.type)}
  <div class="va-node" data-va-type={node.type} data-va-id={nodeId(node, i)}>
    {#if Adapter}
      <Adapter {...node.props} />
    {:else}
      <p class="va-fallback">{fallbackMessage(node.type)}</p>
    {/if}
  </div>
{/each}

<style>
  .va-node {
    width: 100%;
  }

  .va-fallback {
    padding: 12px;
    color: #fca5a5;
    background: rgba(239, 68, 68, 0.08);
    border: 1px dashed rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    font-size: 13px;
    font-family: monospace;
  }
</style>
