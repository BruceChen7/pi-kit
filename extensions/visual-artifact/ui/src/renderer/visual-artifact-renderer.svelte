<script lang="ts">
import { getContext } from "svelte";
import { findClosestVaNode } from "../annotations/annotation-helpers.ts";
import { getAdapter } from "./component-registry.ts";

type ArtifactNode = {
  type: string;
  props: Record<string, unknown>;
  metadata?: { id?: string; label?: string };
};

let {
  nodes,
  basePath = "nodes",
  feedbackActive = false,
}: {
  nodes: ArtifactNode[];
  basePath?: string;
  feedbackActive?: boolean;
} = $props();

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
  {@const isSelected = feedbackActive && feedbackCtx?.store.selectedNode?.nodePath === nPath}

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
      if (!feedbackActive) return;
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
  }

  .va-clickable {
    cursor: pointer;
  }

  .va-node::after {
    content: "";
    position: absolute;
    inset: -4px;
    z-index: 1;
    border: 1px solid transparent;
    border-left-width: 3px;
    border-radius: calc(var(--radius) * 1.4);
    pointer-events: none;
    opacity: 0;
    transition:
      opacity 0.15s ease,
      border-color 0.15s ease,
      background 0.15s ease,
      box-shadow 0.15s ease;
  }

  .va-clickable:hover::after {
    opacity: 1;
    border-color: color-mix(in oklch, var(--clay), transparent 80%);
    border-left-color: var(--clay);
  }

  .va-selected::after {
    opacity: 1;
    border-color: var(--clay);
    border-left-color: var(--clay);
    background: color-mix(in oklch, var(--clay), transparent 92%);
    box-shadow: 0 0 0 1px color-mix(in oklch, var(--clay), transparent 85%);
  }

  /* Subtle scale feedback on click (optional, CSS-only) */
  .va-clickable:active::after {
    background: color-mix(in oklch, var(--clay), transparent 88%);
  }

  .va-fallback {
    padding: 12px;
    color: var(--rust);
    background: color-mix(in oklch, var(--rust), transparent 90%);
    border: 1px dashed color-mix(in oklch, var(--rust), transparent 60%);
    border-radius: calc(var(--radius) * 0.8);
    font-size: 13px;
    font-family: var(--font-mono);
  }
</style>
