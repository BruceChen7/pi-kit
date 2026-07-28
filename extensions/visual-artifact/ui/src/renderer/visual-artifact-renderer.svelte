<script lang="ts">
import { getContext } from "svelte";
// biome-ignore lint/correctness/noUnusedImports: used in template event handler
import { findClosestVaNode } from "../annotations/annotation-helpers.ts";
// biome-ignore lint/correctness/noUnusedImports: used in template as <Adapter>
import { getAdapter } from "./component-registry.ts";

type ArtifactNode = {
  type: string;
  props: Record<string, unknown>;
  metadata?: { id?: string; label?: string };
};

let {
  nodes,
  basePath = "nodes",
}: { nodes: ArtifactNode[]; basePath?: string } = $props();

function nodeId(node: ArtifactNode, index: number): string {
  return node.metadata?.id ?? `node-${index}`;
}

function nodeLabel(node: ArtifactNode): string | undefined {
  const props = node.props as Record<string, unknown> | undefined;
  if (!props) return undefined;
  const raw = props.title ?? props.text ?? props.label ?? props.content;
  if (typeof raw === "string" && raw.length > 0) {
    return raw.slice(0, 80);
  }
  return undefined;
}

function nodePath(index: number): string {
  return `${basePath}.${index}`;
}

function fallbackMessage(type: string): string {
  return `[Unsupported node type: "${type}"]`;
}

/* ---- Feedback context (optional) ---- */

let feedbackCtx: {
  store: {
    selectedNode: { nodePath: string } | null;
    handleNodeClick: (e: MouseEvent) => void;
  };
} | null = $state(null);

try {
  feedbackCtx = getContext("feedback");
} catch {
  // No feedback provider — that's fine for home/project views.
}
</script>

{#each nodes as node, i (nodeId(node, i))}
  {@const Adapter = getAdapter(node.type)}
  {@const nId = nodeId(node, i)}
  {@const nPath = nodePath(i)}
  {@const isSelected = feedbackCtx?.store.selectedNode?.nodePath === nPath}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="va-node"
    class:va-clickable={!!feedbackCtx}
    class:va-selected={isSelected}
    data-va-type={node.type}
    data-va-id={nId}
    data-va-node-id={nId}
    data-va-node-path={nPath}
    data-va-node-type={node.type}
    data-va-node-label={nodeLabel(node)}
    onclick={(e) => {
      if (!feedbackCtx) return;
      e.preventDefault();
      e.stopPropagation();
      feedbackCtx.store.handleNodeClick(e);
    }}
  >
    {#if Adapter}
      <Adapter {...node.props} _nodePath={nPath} />
    {:else}
      <p class="va-fallback">{fallbackMessage(node.type)}</p>
    {/if}
  </div>
{/each}

<style>
  .va-node {
    position: relative;
    width: 100%;
    transition:
      background 0.12s ease,
      box-shadow 0.12s ease;
  }

  .va-clickable {
    cursor: pointer;
  }

  .va-clickable:hover {
    box-shadow: inset 3px 0 0 var(--va-accent-primary);
    border-radius: var(--va-radius-lg);
  }

  .va-selected {
    box-shadow:
      inset 3px 0 0 var(--va-accent-primary),
      inset 0 0 0 1px var(--va-border-info-subtle);
    border-radius: var(--va-radius-lg);
    background: var(--va-bg-selected);
  }

  .va-fallback {
    padding: 12px;
    color: var(--va-accent-danger-text);
    background: var(--va-bg-danger-subtle);
    border: 1px dashed var(--va-border-danger-subtle);
    border-radius: 6px;
    font-size: 13px;
    font-family: monospace;
  }
</style>
