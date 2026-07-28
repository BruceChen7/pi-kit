<script lang="ts">
/**
 * Feedback panel — minimal single-view sidebar.
 *
 * Layout:
 *   Title bar ("Feedback" + close)
 *   Selected node display
 *   Textarea with keyboard shortcut
 *   Pending items list
 *   [Send all (n)] button
 */

import { getContext } from "svelte";

const ctx = getContext<{
  store: {
    isOpen: boolean;
    selectedNode: { nodePath?: string; nodeType?: string } | null;
    pendingItems: { nodePath: string; body: string }[];
    draftText: string;
    isSending: boolean;
    togglePanel: () => void;
    clearSelection: () => void;
    addItem: () => void;
    removeItem: (i: number) => void;
    setDraftText: (v: string) => void;
    sendFeedback: () => Promise<void>;
  };
}>("feedback");

const s = () => ctx.store;
let panelElement = $state<HTMLElement>();
let panelTop = $state(80);

$effect(() => {
  if (!panelElement) return;

  const layout = panelElement.parentElement;
  const firstRenderedNode = layout?.querySelector<HTMLElement>(
    ".artifact-main > .va-node",
  );
  const firstContentNode =
    firstRenderedNode?.dataset.vaType === "section"
      ? (firstRenderedNode.querySelector<HTMLElement>(
          ".va-section-body > .va-node",
        ) ?? firstRenderedNode)
      : firstRenderedNode;
  const updatePanelTop = () => {
    const alignmentTarget = firstContentNode ?? layout;
    panelTop = Math.max(0, alignmentTarget?.getBoundingClientRect().top ?? 0);
  };
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePanelTop);

  updatePanelTop();
  if (layout) observer?.observe(layout);
  if (firstContentNode) observer?.observe(firstContentNode);
  window.addEventListener("scroll", updatePanelTop, { passive: true });
  window.addEventListener("resize", updatePanelTop);

  return () => {
    observer?.disconnect();
    window.removeEventListener("scroll", updatePanelTop);
    window.removeEventListener("resize", updatePanelTop);
  };
});

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && s().draftText.trim()) {
    e.preventDefault();
    s().setDraftText("");
  }
}

function handleComposerKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;

  // Ctrl+Enter: add current text as pending item
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    if (s().draftText.trim()) {
      s().addItem();
    }
  }

  // Cmd+Enter (macOS): add current text + send all to agent
  if (e.metaKey && e.key === "Enter") {
    e.preventDefault();
    if (s().draftText.trim()) {
      s().addItem();
    }
    // Small delay to let the item be added before sending
    requestAnimationFrame(() => {
      s().sendFeedback();
    });
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if s().isOpen}
  <aside
    class="va-feedback-panel"
    aria-label="Feedback"
    bind:this={panelElement}
    style={`--va-panel-top: ${panelTop}px`}
  >
    <!-- Header -->
    <div class="va-panel-header">
      <span class="va-panel-title">Feedback</span>
      <div class="va-spacer"></div>
      {#if s().isSending}
        <span class="va-saving" title="Sending...">&#x21bb;</span>
      {/if}
      <button
        type="button"
        class="va-close-btn"
        onclick={s().togglePanel}
        aria-label="Close"
      >
        &times;
      </button>
    </div>

    <!-- Selected node -->
    <div class="va-selected-node">
      {#if s().selectedNode}
        <span class="va-node-label">
          {s().selectedNode.nodePath}
          {#if s().selectedNode.nodeType}
            <span class="va-node-type">({s().selectedNode.nodeType})</span>
          {/if}
        </span>
        <button
          type="button"
          class="va-clear-btn"
          onclick={s().clearSelection}
          aria-label="Clear selection"
        >
          &times;
        </button>
      {:else}
        <span class="va-hint">Click a node to select it</span>
      {/if}
    </div>

    <!-- Composer -->
    <div class="va-composer">
      <div class="va-textarea-wrap">
        <textarea
          class="va-textarea"
          value={s().draftText}
          oninput={(e) => s().setDraftText(e.currentTarget.value)}
          onkeydown={handleComposerKeydown}
          placeholder="Write feedback..."
          aria-label="Feedback text"
          aria-describedby="va-feedback-shortcut"
        ></textarea>
        <span id="va-feedback-shortcut" class="va-composer-shortcut">
          Ctrl+Enter to add · Cmd+Enter to add &amp; send all
        </span>
      </div>
    </div>

    <!-- Pending list -->
    {#if s().pendingItems.length > 0}
      <div class="va-pending-section">
        <span class="va-pending-title">
          Pending ({s().pendingItems.length})
        </span>
        <div class="va-pending-list">
          {#each s().pendingItems as item, i (i)}
            <div class="va-pending-item">
              <div class="va-pending-meta">
                <span class="va-pending-node">{item.nodePath}</span>
              </div>
              <p class="va-pending-body">{item.body}</p>
              <button
                type="button"
                class="va-remove-btn"
                onclick={() => s().removeItem(i)}
                aria-label="Remove item"
              >
                &times;
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Send button -->
    <div class="va-send-area">
      <button
        type="button"
        class="va-send-btn"
        disabled={s().pendingItems.length === 0 || s().isSending}
        onclick={s().sendFeedback}
      >
        {s().isSending
          ? "Sending..."
          : `Send all (${s().pendingItems.length}) to agent`}
      </button>
    </div>
  </aside>
{/if}

<style>
  .va-feedback-panel {
    position: fixed;
    top: var(--va-panel-top, 0px);
    right: 0;
    width: min(var(--va-comment-panel-width, 360px), 100vw);
    height: calc(100vh - var(--va-panel-top, 0px));
    background: var(--va-bg-surface);
    border-left: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-lg) 0 0 var(--va-radius-lg);
    box-shadow: -12px 0 32px rgba(2, 6, 23, 0.24);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 100;
    font-size: 13px;
    color: var(--va-text-primary);
    box-sizing: border-box;
  }

  .va-feedback-panel :global(*) {
    box-sizing: border-box;
  }

  /* ---- Header ---- */
  .va-panel-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 52px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--va-border-default);
    flex-shrink: 0;
  }

  .va-panel-title {
    font-weight: 650;
    font-size: 15px;
  }

  .va-spacer {
    flex: 1;
  }

  .va-saving {
    color: var(--va-text-muted);
    animation: va-spin 1s linear infinite;
    font-size: 14px;
  }

  @keyframes va-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .va-close-btn {
    background: none;
    border: none;
    color: var(--va-text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .va-close-btn:hover {
    color: var(--va-text-primary);
  }

  /* ---- Selected node ---- */
  .va-selected-node {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 42px;
    padding: 9px 16px;
    border-bottom: 1px solid var(--va-border-default);
    flex-shrink: 0;
  }

  .va-node-label {
    font-size: 12px;
    font-weight: 600;
    font-family: var(--va-font-mono);
    color: var(--va-accent-primary-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .va-node-type {
    color: var(--va-text-muted);
    font-family: var(--va-font-sans);
  }

  .va-hint {
    color: var(--va-text-subtle);
    font-size: 12px;
    font-style: italic;
  }

  .va-clear-btn {
    background: none;
    border: none;
    color: var(--va-text-muted);
    cursor: pointer;
    font-size: 14px;
    padding: 0 2px;
    margin-left: auto;
  }

  .va-clear-btn:hover {
    color: var(--va-accent-danger-text);
  }

  /* ---- Composer ---- */
  .va-composer {
    padding: 14px 16px;
    border-bottom: 1px solid var(--va-border-default);
    flex-shrink: 0;
  }

  .va-textarea-wrap {
    position: relative;
  }

  .va-textarea {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 96px;
    padding: 10px 12px 32px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-sm);
    background: var(--va-bg-app);
    color: var(--va-text-primary);
    font-size: 13px;
    line-height: 1.45;
    font-family: var(--va-font-sans);
    resize: vertical;
  }

  .va-textarea:focus {
    outline: none;
    border-color: var(--va-accent-primary);
  }

  .va-composer-shortcut {
    position: absolute;
    right: 10px;
    bottom: 9px;
    color: var(--va-text-subtle);
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
  }

  /* ---- Pending list ---- */
  .va-pending-section {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .va-pending-title {
    font-size: 11px;
    font-weight: 500;
    color: var(--va-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .va-pending-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .va-pending-item {
    position: relative;
    padding: 10px 32px 10px 10px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-sm);
    background: var(--va-bg-app);
  }

  .va-pending-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 2px;
  }

  .va-pending-node {
    font-size: 10px;
    font-family: var(--va-font-mono);
    color: var(--va-accent-primary-text);
  }

  .va-pending-body {
    margin: 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--va-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .va-remove-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    background: none;
    border: none;
    color: var(--va-text-muted);
    cursor: pointer;
    font-size: 14px;
    padding: 0 2px;
    line-height: 1;
  }

  .va-remove-btn:hover {
    color: var(--va-accent-danger-text);
  }

  /* ---- Send button ---- */
  .va-send-area {
    margin-top: auto;
    padding: 14px 16px 16px;
    border-top: 1px solid var(--va-border-default);
    flex-shrink: 0;
  }

  .va-send-btn {
    width: 100%;
    min-height: 40px;
    padding: 9px 14px;
    border-radius: var(--va-radius-md);
    border: none;
    background: var(--va-accent-primary);
    color: var(--va-text-inverse);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .va-send-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .va-send-btn:disabled {
    border: 1px solid var(--va-border-default);
    background: var(--va-bg-elevated);
    color: var(--va-text-subtle);
    cursor: not-allowed;
  }

</style>
