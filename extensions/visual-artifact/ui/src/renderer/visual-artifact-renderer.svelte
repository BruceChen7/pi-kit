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

/* ---- Annotation context ---- */

// We use a try/getContext pattern so the renderer works both with and without
// an annotation provider present (e.g. home/project views).
let annotationCtx: {
  store: import("../annotations/annotation-store.ts").AnnotationStoreHandle;
  selectNodeForComment: (
    node: import("../annotations/annotation-store.ts").NodeIdentity,
  ) => void;
} | null = $state(null);

try {
  annotationCtx = getContext("annotation");
} catch {
  // No annotation provider — that's fine for home/project views.
}
</script>

{#each nodes as node, i (nodeId(node, i))}
  {@const Adapter = getAdapter(node.type)}
  {@const nId = nodeId(node, i)}
  {@const nPath = nodePath(i)}
  {#if annotationCtx}
    {@const store = annotationCtx.store}
    {@const isCommentMode = store.isCommentMode}
    {@const isPicking = store.isPickingNode}
    {@const threadCount = store.getThreadCount(nId, nPath)}
    {@const isHovered = store.hoveredNode?.nodePath === nPath}
    {@const isCandidate = store.pickCandidateNode?.nodePath === nPath}
    {@const isSelected = (store.selectedNode?.nodePath === nPath) || (store.highlightedNode?.nodePath === nPath) || isCandidate}
    {@const isPreview = store.previewNode?.nodePath === nPath}
    {@const annotationState = isSelected ? "selected" : (isHovered || isPreview) ? "hovered" : threadCount > 0 ? "has-thread" : "idle"}
    {@const isClickable = isCommentMode || isPicking}

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="va-node"
      class:va-clickable={isClickable}
      data-va-type={node.type}
      data-va-id={nId}
      data-va-node-id={nId}
      data-va-node-path={nPath}
      data-va-node-type={node.type}
      data-va-node-label={nodeLabel(node)}
      data-annotation-state={annotationState}
      onclick={(e) => {
        if (!isClickable) return;
        // In pick mode, find the closest VA node and select it.
        const found = findClosestVaNode(e.target);
        if (found) {
          e.preventDefault();
          e.stopPropagation();
          annotationCtx.selectNodeForComment(found);
        }
      }}
      onmouseenter={() => {
        if (isClickable) store.setHoveredNode({ nodeId: nId, nodePath: nPath });
      }}
      onmouseleave={() => {
        if (isClickable) store.setHoveredNode(null);
      }}
      role={isClickable ? "button" : undefined}
      tabindex={isClickable ? 0 : undefined}
      aria-label={isClickable ? `Comment on ${node.type} node` : undefined}
    >
      <!-- Annotation overlay ring -->
      <div
        class="va-annotation-ring"
        class:va-ring-hovered={annotationState === "hovered"}
        class:va-ring-selected={annotationState === "selected"}
        class:va-ring-has-thread={annotationState === "has-thread"}
      ></div>

      {#if Adapter}
        <Adapter {...node.props} _nodePath={nPath} />
      {:else}
        <p class="va-fallback">{fallbackMessage(node.type)}</p>
      {/if}

      <!-- Thread count badge -->
      {#if isCommentMode && threadCount > 0}
        <span class="va-thread-badge">{threadCount}</span>
      {/if}
    </div>
  {:else}
    <!-- No annotation context — plain renderer -->
    <div class="va-node" data-va-type={node.type} data-va-id={nId}>
      {#if Adapter}
        <Adapter {...node.props} _nodePath={nPath} />
      {:else}
        <p class="va-fallback">{fallbackMessage(node.type)}</p>
      {/if}
    </div>
  {/if}
{/each}

<style>
  .va-node {
    position: relative;
    width: 100%;
  }

  .va-clickable {
    cursor: pointer;
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

  /* ---- Annotation ring overlay ---- */
  .va-annotation-ring {
    pointer-events: none;
    position: absolute;
    inset: 0;
    border-radius: var(--va-radius-lg);
    transition: all 0.12s ease;
    opacity: 0;
  }

  .va-ring-hovered {
    opacity: 1;
    box-shadow: 0 0 0 2px var(--va-accent-primary);
    background: var(--va-bg-info-subtle);
  }

  .va-ring-selected {
    opacity: 1;
    box-shadow: 0 0 0 2px var(--va-accent-primary);
    background: var(--va-bg-selected);
  }

  .va-ring-has-thread {
    opacity: 1;
    box-shadow: 0 0 0 1px var(--va-accent-primary);
    background: var(--va-bg-info-subtle);
  }

  /* ---- Thread count badge ---- */
  .va-thread-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: var(--va-accent-primary);
    color: var(--va-text-inverse);
    font-size: 10px;
    font-weight: 600;
    z-index: 10;
    box-shadow: var(--va-shadow-badge);
  }
</style>
