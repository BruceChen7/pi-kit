<script lang="ts">
/**
 * Annotation panel — right sidebar for comment threads.
 *
 * Three views controlled by panelView:
 * - "list"     → ThreadList with filter tabs
 * - "composer" → Create new thread for selected node
 * - "thread"   → View thread detail, reply, resolve
 */

import { getContext, onMount } from "svelte";

/* ------------------------------------------------------------------ */
/*  Context                                                            */
/* ------------------------------------------------------------------ */

const ctx = getContext<{
  store: import("./annotation-store.ts").AnnotationStoreHandle;
  selectNodeForComment: (
    node: import("./annotation-store.ts").NodeIdentity,
  ) => void;
  createThread: (
    anchor: {
      nodeId?: string;
      nodePath: string;
      nodeType?: string;
      textSnippet?: string;
    },
    body: string,
  ) => Promise<void>;
  addReply: (threadId: string, body: string) => Promise<void>;
  resolveThread: (threadId: string) => Promise<void>;
  reopenThread: (threadId: string) => Promise<void>;
}>("annotation");

const s = () => ctx.store;

/* ------------------------------------------------------------------ */
/*  Derived state                                                      */
/* ------------------------------------------------------------------ */

let open = $derived(s().isCommentMode && !s().isPickingNode);
let currentThread = $derived(
  s().activeThreadId
    ? (s().doc?.threads.find((t) => t.id === s().activeThreadId) ?? null)
    : null,
);
let view = $derived(s().panelView);

/* ------------------------------------------------------------------ */
/*  Composer state (CreateThreadComposer)                              */
/* ------------------------------------------------------------------ */

let composerDraft = $state("");
let isCreating = $state(false);

let composerSelectedNode = $derived(s().selectedNode);
let nodeThreads = $derived(
  composerSelectedNode
    ? s().getThreadsForNode(
        composerSelectedNode.nodeId,
        composerSelectedNode.nodePath,
      )
    : [],
);

async function handleCreate() {
  if (!composerSelectedNode || !composerDraft.trim() || isCreating) return;
  isCreating = true;
  await ctx.createThread(
    {
      nodeId: composerSelectedNode.nodeId,
      nodePath: composerSelectedNode.nodePath,
      nodeType: composerSelectedNode.nodeType ?? "node",
      textSnippet: composerSelectedNode.textSnippet,
    },
    composerDraft,
  );
  composerDraft = "";
  isCreating = false;
}

/* ------------------------------------------------------------------ */
/*  Reply composer state (ThreadDetail)                                */
/* ------------------------------------------------------------------ */

let replyText = $state("");
let isSubmitting = $state(false);

async function handleSubmitReply(threadId: string) {
  if (!replyText.trim() || isSubmitting) return;
  isSubmitting = true;
  await ctx.addReply(threadId, replyText);
  replyText = "";
  isSubmitting = false;
}

onMount(() => {
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && replyText.trim()) {
      event.preventDefault();
      replyText = "";
    }
  }
  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
});

/* ------------------------------------------------------------------ */
/*  Format helper                                                      */
/* ------------------------------------------------------------------ */

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
</script>

{#if open}
  <aside class="va-annotation-panel" aria-label="Comments">
    <!-- Header -->
    <div class="va-panel-header">
      {#if view === "thread" && currentThread}
        <button type="button" class="va-back-btn" onclick={() => s().goBack()}>
          &larr;
        </button>
        <span class="va-panel-title">Thread</span>
        <div class="va-spacer"></div>

        {#if currentThread.status === "resolved"}
          <button
            type="button"
            class="va-action-btn"
            onclick={() => ctx.reopenThread(currentThread.id)}
          >
            Reopen
          </button>
        {:else}
          <button
            type="button"
            class="va-action-btn va-resolve-btn"
            onclick={() => ctx.resolveThread(currentThread.id)}
          >
            Resolve
          </button>
        {/if}

      {:else if view === "composer" && s().selectedNode}
        <button type="button" class="va-back-btn" onclick={() => s().goBack()}>
          &larr;
        </button>
        <span class="va-panel-title">New comment</span>
        <span class="va-snippet">
          {s().selectedNode.textSnippet ?? s().selectedNode.nodeType ?? "node"}
        </span>

      {:else}
        <span class="va-panel-title">Comments</span>
        {#if s().totalThreadCount > 0}
          <span class="va-badge">{s().totalThreadCount}</span>
        {/if}
        <div class="va-spacer"></div>
        {#if s().isSaving}
          <span class="va-saving-indicator" title="Saving...">&#x21bb;</span>
        {/if}
        <button
          type="button"
          class="va-action-btn"
          class:va-active={s().isPickingNode}
          onclick={() => {
            if (s().isPickingNode) {
              s().stopNodePick();
            } else {
              s().startNodePick();
            }
          }}
          title={s().isPickingNode ? "Stop selecting" : "Select a component to comment"}
        >
          {s().isPickingNode ? "Selecting..." : "+ New"}
        </button>
      {/if}
    </div>

    <!-- Content -->
    <div class="va-panel-content">
      {#if s().isLoading}
        <div class="va-empty-state">
          <p>Loading comments...</p>
        </div>

      {:else if s().error}
        <div class="va-error-state">
          <p>{s().error}</p>
          <button type="button" class="va-text-btn" onclick={() => s().resetError()}>
            Dismiss
          </button>
        </div>

      {:else if view === "thread" && s().activeThreadId}
        {@const thread = s().doc?.threads.find((t) => t.id === s().activeThreadId)}
        {#if thread}
          <!-- Thread detail -->
          <div class="va-thread-detail">
            <div class="va-messages">
              {#each thread.messages as message (message.id)}
                <div class="va-message">
                  <div class="va-message-header">
                    <span class="va-author-name">{message.author.name}</span>
                    {#if message.author.name === "Anonymous" && !message.author.email}
                      <span class="va-fallback-tag">(local)</span>
                    {/if}
                    <span class="va-message-time">{formatTime(message.createdAt)}</span>
                  </div>
                  <p class="va-message-body">{message.body}</p>
                </div>
              {/each}
            </div>

            <div class="va-reply-composer">
              {#if thread.status === "resolved"}
                <p class="va-resolved-notice">This thread is resolved.</p>
              {:else}
                <textarea
                  class="va-textarea"
                  bind:value={replyText}
                  placeholder="Reply..."
                  aria-label="Reply"
                ></textarea>
                <div class="va-composer-footer">
                  <button
                    type="button"
                    class="va-primary-btn"
                    disabled={!replyText.trim() || isSubmitting || s().authorStatus === "loading"}
                    onclick={() => handleSubmitReply(thread.id)}
                  >
                    Reply
                  </button>
                </div>
              {/if}
            </div>
          </div>
        {:else}
          <!-- Thread not found, show list -->
          {@render ThreadListContent()}
        {/if}

      {:else if view === "composer" && s().selectedNode}
        <!-- Create thread composer -->
        <div class="va-composer-view">
          {#if nodeThreads.length > 0}
            <div class="va-node-threads">
              <p class="va-section-label">Existing threads</p>
              {#each nodeThreads as t (t.id)}
                <button
                  type="button"
                  class="va-node-thread-card"
                  onclick={() => s().selectThread(t.id)}
                >
                  <span class="va-node-thread-status" class:va-resolved={t.status === "resolved"}>
                    {t.status}
                  </span>
                  <span>{t.messages.length} {t.messages.length === 1 ? "reply" : "replies"}</span>
                </button>
              {/each}
            </div>
          {/if}

          <div class="va-new-comment">
            <textarea
              class="va-textarea"
              bind:value={composerDraft}
              placeholder="Start a comment..."
              aria-label="New comment"
            ></textarea>
            <div class="va-composer-footer">
              <button
                type="button"
                class="va-primary-btn"
                disabled={!composerDraft.trim() || isCreating || s().authorStatus === "loading"}
                onclick={handleCreate}
              >
                Post
              </button>
            </div>
          </div>
        </div>

      {:else}
        <!-- Thread list -->
        {@render ThreadListContent()}
      {/if}
    </div>
  </aside>
{/if}

<!-- ThreadListContent (reusable snippet rendered inline via duplicated template, or we keep it as is) -->
{#snippet ThreadListContent()}
  <div class="va-thread-list">
    <div class="va-filter-row">
      <button
        type="button"
        class="va-filter-btn"
        class:va-filter-active={s().filter === "all"}
        onclick={() => s().setFilter("all")}
      >
        All {s().totalThreadCount > 0 ? `(${s().totalThreadCount})` : ""}
      </button>
      <button
        type="button"
        class="va-filter-btn"
        class:va-filter-active={s().filter === "open"}
        onclick={() => s().setFilter("open")}
      >
        Open {s().openThreadCount > 0 ? `(${s().openThreadCount})` : ""}
      </button>
      <button
        type="button"
        class="va-filter-btn"
        class:va-filter-active={s().filter === "resolved"}
        onclick={() => s().setFilter("resolved")}
      >
        Resolved {s().resolvedThreadCount > 0 ? `(${s().resolvedThreadCount})` : ""}
      </button>
    </div>

    <div class="va-thread-cards">
      {#if s().filteredThreads.length === 0}
        <div class="va-empty-state">
          <p>No {s().filter === "all" ? "" : s().filter} threads yet.</p>
          <p class="va-hint">
            {s().isPickingNode
              ? "Click a component to comment."
              : 'Click "+ New" to start.'}
          </p>
        </div>
      {/if}

      {#each s().filteredThreads as thread (thread.id)}
        {@const lastMsg = thread.messages[thread.messages.length - 1]}
        {@const label = thread.anchor.textSnippet ?? thread.anchor.nodeType ?? "node"}
        <button
          type="button"
          class="va-thread-card"
          class:va-active={s().activeThreadId === thread.id}
          onclick={() => s().selectThread(thread.id)}
          onmouseenter={() => s().setPreviewNode(threadNodeIdentity(thread))}
          onmouseleave={() => s().setPreviewNode(null)}
        >
          <div class="va-thread-card-header">
            <span class="va-thread-label">{label}</span>
            <span class="va-thread-badge" class:va-resolved={thread.status === "resolved"}>
              {thread.status === "resolved" ? "Resolved" : "Open"}
            </span>
          </div>
          <p class="va-thread-preview">{lastMsg?.body ?? ""}</p>
          <div class="va-thread-meta">
            {#if lastMsg?.author?.name}
              <span>{lastMsg.author.name}</span>
            {/if}
            <span>{thread.messages.length} {thread.messages.length === 1 ? "reply" : "replies"}</span>
          </div>
        </button>
      {/each}
    </div>
  </div>
{/snippet}

<style>
  /* ---- Panel root ---- */
  .va-annotation-panel {
    position: fixed;
    top: 0;
    right: 0;
    width: 320px;
    height: 100vh;
    background: var(--va-bg-surface);
    border-left: 1px solid var(--va-border-default);
    display: flex;
    flex-direction: column;
    z-index: 100;
    font-size: 13px;
    color: var(--va-text-primary);
  }

  /* ---- Header ---- */
  .va-panel-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--va-border-default);
    flex-shrink: 0;
  }

  .va-panel-title {
    font-weight: 600;
    font-size: 14px;
  }

  .va-snippet {
    color: var(--va-text-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .va-spacer {
    flex: 1;
  }

  .va-badge {
    background: var(--va-accent-primary);
    color: var(--va-text-inverse);
    font-size: 10px;
    padding: 0 6px;
    border-radius: 999px;
    line-height: 16px;
  }

  .va-back-btn {
    background: none;
    border: none;
    color: var(--va-accent-primary-text);
    cursor: pointer;
    font-size: 16px;
    padding: 0 2px;
  }

  .va-action-btn {
    background: none;
    border: 1px solid var(--va-border-strong);
    border-radius: var(--va-radius-sm);
    padding: 3px 8px;
    font-size: 11px;
    color: var(--va-text-primary);
    cursor: pointer;
  }

  .va-action-btn:hover {
    background: var(--va-bg-hover);
  }

  .va-active {
    background: var(--va-accent-primary);
    color: var(--va-text-inverse);
    border-color: var(--va-accent-primary);
  }

  .va-resolve-btn {
    color: var(--va-accent-success-text);
    border-color: var(--va-accent-success);
  }

  .va-saving-indicator {
    color: var(--va-text-muted);
    animation: va-spin 1s linear infinite;
    font-size: 14px;
  }

  @keyframes va-spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* ---- Content area ---- */
  .va-panel-content {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  /* ---- Empty / error state ---- */
  .va-empty-state {
    text-align: center;
    padding: 32px 16px;
    color: var(--va-text-muted);
  }

  .va-hint {
    font-size: 11px;
    color: var(--va-text-subtle);
    margin-top: 4px;
  }

  .va-error-state {
    padding: 16px;
    color: var(--va-accent-danger-text);
    background: var(--va-bg-danger-subtle);
    margin: 8px;
    border-radius: var(--va-radius-md);
  }

  .va-text-btn {
    background: none;
    border: none;
    color: var(--va-accent-primary-text);
    cursor: pointer;
    font-size: 12px;
    margin-top: 8px;
  }

  /* ---- Thread list ---- */
  .va-filter-row {
    display: flex;
    gap: 4px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--va-border-default);
  }

  .va-filter-btn {
    background: none;
    border: none;
    border-radius: var(--va-radius-sm);
    padding: 3px 8px;
    font-size: 11px;
    color: var(--va-text-muted);
    cursor: pointer;
  }

  .va-filter-btn:hover {
    color: var(--va-text-primary);
    background: var(--va-bg-hover);
  }

  .va-filter-active {
    background: var(--va-bg-elevated);
    color: var(--va-text-primary);
  }

  .va-thread-cards {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .va-thread-card {
    display: block;
    text-align: left;
    width: 100%;
    padding: 10px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-md);
    background: var(--va-bg-app);
    cursor: pointer;
  }

  .va-thread-card:hover {
    border-color: var(--va-accent-primary);
  }

  .va-thread-card.va-active {
    border-color: var(--va-accent-primary);
    background: var(--va-bg-selected);
  }

  .va-thread-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }

  .va-thread-label {
    font-weight: 500;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .va-thread-badge.va-resolved {
    color: var(--va-text-muted);
  }

  .va-thread-preview {
    font-size: 11px;
    color: var(--va-text-muted);
    line-height: 1.4;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .va-thread-meta {
    font-size: 10px;
    color: var(--va-text-subtle);
    margin-top: 4px;
    display: flex;
    gap: 8px;
  }

  /* ---- Thread detail ---- */
  .va-thread-detail {
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .va-messages {
    flex: 1;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .va-message {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .va-message-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .va-author-name {
    font-weight: 500;
    font-size: 12px;
  }

  .va-fallback-tag {
    font-size: 10px;
    color: var(--va-text-subtle);
  }

  .va-message-time {
    font-size: 10px;
    color: var(--va-text-subtle);
    margin-left: auto;
  }

  .va-message-body {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .va-reply-composer {
    border-top: 1px solid var(--va-border-default);
    padding: 10px;
  }

  .va-resolved-notice {
    font-size: 11px;
    color: var(--va-text-muted);
    text-align: center;
    padding: 8px;
  }

  /* ---- Textarea ---- */
  .va-textarea {
    width: 100%;
    min-height: 60px;
    padding: 8px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-sm);
    background: var(--va-bg-app);
    color: var(--va-text-primary);
    font-size: 12px;
    font-family: var(--va-font-sans);
    resize: vertical;
    box-sizing: border-box;
  }

  .va-textarea:focus {
    outline: none;
    border-color: var(--va-accent-primary);
  }

  .va-composer-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }

  .va-primary-btn {
    background: var(--va-accent-primary);
    color: var(--va-text-inverse);
    border: none;
    border-radius: var(--va-radius-sm);
    padding: 5px 14px;
    font-size: 12px;
    cursor: pointer;
  }

  .va-primary-btn:hover {
    opacity: 0.9;
  }

  .va-primary-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ---- Composer view ---- */
  .va-composer-view {
    display: flex;
    flex-direction: column;
    flex: 1;
    padding: 10px;
    gap: 10px;
  }

  .va-section-label {
    font-size: 11px;
    color: var(--va-text-muted);
    font-weight: 500;
    margin: 0 0 4px 0;
  }

  .va-node-threads {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .va-node-thread-card {
    display: flex;
    justify-content: space-between;
    padding: 8px;
    border: 1px solid var(--va-border-default);
    border-radius: var(--va-radius-sm);
    background: var(--va-bg-app);
    cursor: pointer;
    font-size: 11px;
    color: var(--va-text-primary);
    text-align: left;
  }

  .va-node-thread-card:hover {
    border-color: var(--va-accent-primary);
  }

  .va-node-thread-status.va-resolved {
    color: var(--va-text-muted);
  }

  .va-new-comment {
    display: flex;
    flex-direction: column;
    flex: 1;
  }
</style>
