<script lang="ts">
/**
 * Annotation provider — owns all reactive annotation state via Svelte runes.
 *
 * This is the only place where $state / $derived are used, because the Svelte
 * compiler only processes runes inside .svelte files, not plain .ts files.
 *
 * Exposes everything through setContext("annotation") so child components
 * can access the store, helpers, and mutation methods.
 */

import { onMount, type Snippet, setContext } from "svelte";
import { createMutationQueue } from "./annotation-queue.ts";
import {
  type AnnotationAnchor,
  type AnnotationAuthor,
  type AnnotationDocument,
  type AnnotationMessage,
  type AnnotationMutation,
  type AuthorStatus,
  createSelectNodeForComment,
  getThreadCount,
  getThreadsForNode,
  type NodeIdentity,
  type PanelView,
  scrollToNode,
  type ThreadFilter,
} from "./annotation-store.ts";

let {
  project: _project,
  slug: _slug,
  commentModeActive = $bindable(false),
  onThreadCountChange = (_n: number) => {},
  children,
}: {
  project: string;
  slug: string;
  commentModeActive?: boolean;
  onThreadCountChange?: (n: number) => void;
  children: Snippet;
} = $props();

/* ------------------------------------------------------------------ */
/*  Store state — all reactive state lives here as $state              */
/* ------------------------------------------------------------------ */

let doc = $state<AnnotationDocument | null>(null);
let isLoading = $state(true);
let error = $state<string | null>(null);
let isSaving = $state(false);

let author = $state<AnnotationAuthor>({ name: "Anonymous" });
let authorStatus = $state<AuthorStatus>("loading");

let isCommentMode = $state(false);
let isPickingNode = $state(false);

/* Sync commentModeActive (from parent) ↔ isCommentMode (internal) */
$effect(() => {
  if (commentModeActive !== isCommentMode) {
    if (commentModeActive) {
      // Parent opened comments
      isCommentMode = true;
      isPickingNode = true;
      pickCandidateNode = null;
      error = null;
    } else {
      // Parent closed comments — reset all
      isCommentMode = false;
      isPickingNode = false;
      pickCandidateNode = null;
      selectedNode = null;
      highlightedNode = null;
      previewNode = null;
      activeThreadId = null;
      panelView = "list";
      draftText = "";
      error = null;
    }
  }
});

/* Propagate internal isCommentMode changes back to parent */
$effect(() => {
  commentModeActive = isCommentMode;
  onThreadCountChange(totalThreadCount);
});
let pickCandidateNode = $state<NodeIdentity | null>(null);
let hoveredNode = $state<NodeIdentity | null>(null);
let selectedNode = $state<NodeIdentity | null>(null);
let highlightedNode = $state<NodeIdentity | null>(null);
let previewNode = $state<NodeIdentity | null>(null);
let activeThreadId = $state<string | null>(null);
let panelView = $state<PanelView>("list");
let filter = $state<ThreadFilter>("all");
let draftText = $state("");

/* ---- Derived ---- */

let filteredThreads = $derived.by(() => {
  if (!doc) return [];
  if (filter === "all") return doc.threads;
  return doc.threads.filter((t) => t.status === filter);
});

let totalThreadCount = $derived(doc?.threads.length ?? 0);
let openThreadCount = $derived(
  doc?.threads.filter((t) => t.status === "open").length ?? 0,
);
let resolvedThreadCount = $derived(
  doc?.threads.filter((t) => t.status === "resolved").length ?? 0,
);

/* ---- Bound helpers ---- */

const selectNodeForComment = createSelectNodeForComment(
  (v) => (selectedNode = v),
  (v) => (pickCandidateNode = v),
  (v) => (draftText = v),
  (v) => (highlightedNode = v),
  (v) => (previewNode = v),
  (v) => (panelView = v as PanelView),
  (v) => (isPickingNode = v),
);

/* ------------------------------------------------------------------ */
/*  Store object — exposed through context                             */
/* ------------------------------------------------------------------ */

const store = {
  get doc() {
    return doc;
  },
  get isLoading() {
    return isLoading;
  },
  get error() {
    return error;
  },
  get isSaving() {
    return isSaving;
  },
  get author() {
    return author;
  },
  get authorStatus() {
    return authorStatus;
  },
  get isCommentMode() {
    return isCommentMode;
  },
  get isPickingNode() {
    return isPickingNode;
  },
  get pickCandidateNode() {
    return pickCandidateNode;
  },
  get hoveredNode() {
    return hoveredNode;
  },
  get selectedNode() {
    return selectedNode;
  },
  get highlightedNode() {
    return highlightedNode;
  },
  get previewNode() {
    return previewNode;
  },
  get activeThreadId() {
    return activeThreadId;
  },
  get panelView() {
    return panelView;
  },
  get filter() {
    return filter;
  },
  get draftText() {
    return draftText;
  },
  get filteredThreads() {
    return filteredThreads;
  },
  get totalThreadCount() {
    return totalThreadCount;
  },
  get openThreadCount() {
    return openThreadCount;
  },
  get resolvedThreadCount() {
    return resolvedThreadCount;
  },

  setDoc(v: AnnotationDocument | null) {
    doc = v;
  },
  setLoading(v: boolean) {
    isLoading = v;
  },
  setError(v: string | null) {
    error = v;
  },
  setSaving(v: boolean) {
    isSaving = v;
  },
  setAuthor(v: AnnotationAuthor) {
    author = v;
  },
  setAuthorStatus(v: AuthorStatus) {
    authorStatus = v;
  },

  openComments() {
    commentModeActive = true;
  },

  closeComments() {
    commentModeActive = false;
  },

  startNodePick() {
    isPickingNode = true;
    pickCandidateNode = null;
  },
  stopNodePick() {
    isPickingNode = false;
    pickCandidateNode = null;
  },
  setPickCandidateNode(v: NodeIdentity | null) {
    pickCandidateNode = v;
  },
  setHoveredNode(v: NodeIdentity | null) {
    hoveredNode = v;
  },
  setHighlightedNode(v: NodeIdentity | null) {
    highlightedNode = v;
  },
  setPreviewNode(v: NodeIdentity | null) {
    previewNode = v;
  },
  setDraftText(v: string) {
    draftText = v;
  },
  setFilter(v: ThreadFilter) {
    filter = v;
  },

  selectThread(threadId: string) {
    const thread = doc?.threads.find((t) => t.id === threadId);
    if (!thread) return;
    activeThreadId = threadId;
    panelView = "thread";
    highlightedNode = {
      nodeId: thread.anchor.nodeId,
      nodePath: thread.anchor.nodePath,
      nodeType: thread.anchor.nodeType,
      textSnippet: thread.anchor.textSnippet,
    };
    scrollToNode(thread.anchor.nodeId, thread.anchor.nodePath);
  },

  goBack() {
    if (panelView === "thread") {
      panelView = selectedNode ? "composer" : "list";
      activeThreadId = null;
    } else if (panelView === "composer") {
      panelView = "list";
      selectedNode = null;
    }
  },

  clearSelection() {
    activeThreadId = null;
    selectedNode = null;
    highlightedNode = null;
    previewNode = null;
    draftText = "";
    panelView = "list";
  },

  resetError() {
    error = null;
  },

  getThreadsForNode(nodeId: string | undefined, nodePath: string) {
    return doc ? getThreadsForNode(doc.threads, nodeId, nodePath) : [];
  },

  getThreadCount(nodeId: string | undefined, nodePath: string) {
    return doc ? getThreadCount(doc.threads, nodeId, nodePath) : 0;
  },
};

/* ------------------------------------------------------------------ */
/*  Bridge communication                                              */
/* ------------------------------------------------------------------ */

function bridgeSend(message: unknown): void {
  window.glimpse?.send(message);
}

function sendMutations(
  projectNameParam: string,
  slugNameParam: string,
  mutations: AnnotationMutation[],
): Promise<AnnotationDocument> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Annotation mutation timed out"));
    }, 10_000);

    function onResult(e: Event) {
      const detail = (e as CustomEvent).detail as {
        projectName: string;
        slug: string;
        annotations: AnnotationDocument;
      } | null;
      if (
        detail?.projectName === projectNameParam &&
        detail?.slug === slugNameParam &&
        detail?.annotations
      ) {
        cleanup();
        resolve(detail.annotations);
      }
    }

    function onError(e: Event) {
      const detail = (e as CustomEvent).detail as { message?: string } | null;
      cleanup();
      reject(new Error(detail?.message ?? "Annotation mutation failed"));
    }

    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener("visual-artifact:annotation-result", onResult);
      window.removeEventListener("visual-artifact:error", onError);
    }

    window.addEventListener("visual-artifact:annotation-result", onResult);
    window.addEventListener("visual-artifact:error", onError);

    bridgeSend({
      type: "annotation-mutation",
      projectName: projectNameParam,
      slug: slugNameParam,
      mutations,
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Mutation queue                                                     */
/* ------------------------------------------------------------------ */

let queue!: ReturnType<typeof createMutationQueue>;

/* ------------------------------------------------------------------ */
/*  Author helpers                                                     */
/* ------------------------------------------------------------------ */

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeMessage(body: string): AnnotationMessage {
  const now = new Date().toISOString();
  return {
    id: generateId(),
    author: author,
    body: body.trim(),
    createdAt: now,
  };
}

async function createThread(anchor: AnnotationAnchor, body: string) {
  const trimmed = body.trim();
  if (!trimmed) return;

  const message = makeMessage(trimmed);
  const now = message.createdAt;
  const threadId = generateId();
  const thread = {
    id: threadId,
    anchor,
    status: "open" as const,
    createdAt: now,
    updatedAt: now,
    messages: [message],
  };

  await queue.enqueue(
    (current) => ({
      ...current,
      threads: [...current.threads, thread],
    }),
    [
      {
        type: "createThread",
        threadId,
        anchor,
        author: author,
        body: trimmed,
      } as AnnotationMutation,
    ],
  );

  store.selectThread(threadId);
  draftText = "";
}

async function addReply(threadId: string, body: string) {
  const trimmed = body.trim();
  if (!trimmed) return;

  const message = makeMessage(trimmed);
  const mutations: AnnotationMutation[] = [
    {
      type: "addMessage",
      threadId,
      messageId: message.id,
      author: author,
      body: trimmed,
    },
  ];

  await queue.enqueue(
    (current) => ({
      ...current,
      threads: current.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: [...t.messages, message],
              updatedAt: message.createdAt,
            }
          : t,
      ),
    }),
    mutations,
  );
}

async function resolveThread(threadId: string) {
  await queue.enqueue(
    (current) => ({
      ...current,
      threads: current.threads.map((t) =>
        t.id === threadId ? { ...t, status: "resolved" as const } : t,
      ),
    }),
    [{ type: "resolveThread", threadId }],
  );
}

async function reopenThread(threadId: string) {
  await queue.enqueue(
    (current) => ({
      ...current,
      threads: current.threads.map((t) =>
        t.id === threadId ? { ...t, status: "open" as const } : t,
      ),
    }),
    [{ type: "reopenThread", threadId }],
  );
}

/* ------------------------------------------------------------------ */
/*  Context setup                                                      */
/* ------------------------------------------------------------------ */

const ctx = {
  store,
  selectNodeForComment,
  createThread,
  addReply,
  resolveThread,
  reopenThread,
};

setContext("annotation", ctx);

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

onMount(() => {
  /* Initialize mutation queue inside mount closure to avoid
     state_referenced_locally warning from Svelte 5 */
  queue = createMutationQueue(_project, _slug, sendMutations, store);

  function onAnnotations(e: Event) {
    const detail = (e as CustomEvent).detail as {
      projectName: string;
      slug: string;
      annotations: AnnotationDocument;
    } | null;
    if (
      detail?.projectName === _project &&
      detail?.slug === _slug &&
      detail?.annotations
    ) {
      store.setDoc(detail.annotations);
      store.setLoading(false);
    }
  }

  window.addEventListener("visual-artifact:annotations", onAnnotations);

  bridgeSend({ type: "list-annotations", projectName: _project, slug: _slug });

  // Set fallback author for Glimpse
  store.setAuthor({ name: "Glimpse User" });
  store.setAuthorStatus("fallback");

  return () => {
    window.removeEventListener("visual-artifact:annotations", onAnnotations);
    store.closeComments();
  };
});
</script>

{@render children()}
