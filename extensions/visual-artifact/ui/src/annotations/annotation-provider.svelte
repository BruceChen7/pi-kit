<script lang="ts">
/**
 * Feedback provider — simplified state for the Feedback panel.
 *
 * No threads, no modes, no mutation queue, no author tracking.
 * Just: select node → write note → add to pending list → send all.
 */

import { type Snippet, setContext } from "svelte";
import { findClosestVaNode } from "./annotation-helpers.ts";
import type { FeedbackItem, NodeIdentity } from "./annotation-types.ts";

let {
  project: _project,
  slug: _slug,
  feedbackOpen = $bindable(false),
  children,
}: {
  project: string;
  slug: string;
  feedbackOpen?: boolean;
  children: Snippet;
} = $props();

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

let selectedNode = $state<NodeIdentity | null>(null);
let pendingItems = $state<FeedbackItem[]>([]);
let draftText = $state("");
let isSending = $state(false);

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

function togglePanel(): void {
  feedbackOpen = !feedbackOpen;
  if (!feedbackOpen) {
    selectedNode = null;
    draftText = "";
  }
}

function selectNode(node: NodeIdentity): void {
  selectedNode = node;
}

function clearSelection(): void {
  selectedNode = null;
}

function addItem(): void {
  const body = draftText.trim();
  if (!body) return;
  const nPath = selectedNode?.nodePath ?? "(artifact)";
  pendingItems = [...pendingItems, { nodePath: nPath, body }];
  draftText = "";
  selectedNode = null;
}

function removeItem(index: number): void {
  pendingItems = pendingItems.filter((_, i) => i !== index);
}

function handleNodeClick(e: MouseEvent): void {
  const found = findClosestVaNode(e.target);
  if (!found) return;
  e.preventDefault();
  e.stopPropagation();
  selectNode(found);
  // Auto-open panel if not already open
  if (!feedbackOpen) feedbackOpen = true;
}

function sendFeedback(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pendingItems.length === 0) {
      resolve();
      return;
    }

    isSending = true;

    const timeout = setTimeout(() => {
      cleanup();
      isSending = false;
      reject(new Error("Sending feedback timed out"));
    }, 10_000);

    function onSent() {
      cleanup();
      isSending = false;
      pendingItems = [];
      feedbackOpen = false;
      resolve();
    }

    function onError(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { message?: string }
        | undefined;
      cleanup();
      isSending = false;
      reject(new Error(detail?.message ?? "Sending feedback failed"));
    }

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener("visual-artifact:feedback-sent", onSent);
      window.removeEventListener("visual-artifact:error", onError);
    }

    window.addEventListener("visual-artifact:feedback-sent", onSent);
    window.addEventListener("visual-artifact:error", onError);

    window.glimpse?.send({
      type: "feedback",
      items: pendingItems,
      slug: _slug,
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Store object — exposed through context                             */
/* ------------------------------------------------------------------ */

const store = {
  get isOpen() {
    return feedbackOpen;
  },
  get selectedNode() {
    return selectedNode;
  },
  get pendingItems() {
    return pendingItems;
  },
  get draftText() {
    return draftText;
  },
  get isSending() {
    return isSending;
  },
  togglePanel: () => togglePanel(),
  selectNode: (node: NodeIdentity) => selectNode(node),
  clearSelection: () => clearSelection(),
  addItem: () => addItem(),
  removeItem: (i: number) => removeItem(i),
  setDraftText: (v: string) => (draftText = v),
  handleNodeClick: (e: MouseEvent) => handleNodeClick(e),
  sendFeedback: () => sendFeedback(),
};

const ctx = { store };

setContext("feedback", ctx);
</script>

{@render children()}
