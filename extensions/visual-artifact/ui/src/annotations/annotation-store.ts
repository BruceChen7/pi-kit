/**
 * Annotation state — pure helper functions.
 *
 * This file does NOT use Svelte runes ($state/$derived).
 * Reactive state lives in annotation-provider.svelte and is exposed via context.
 */

import {
  getThreadCount,
  getThreadsForNode,
  scrollToNode,
} from "./annotation-helpers.ts";

/* ------------------------------------------------------------------ */
/*  Re-export types and helpers for convenience                        */
/* ------------------------------------------------------------------ */

export type {
  AnnotationAnchor,
  AnnotationAuthor,
  AnnotationDocument,
  AnnotationMessage,
  AnnotationMutation,
  AnnotationThread,
  AuthorStatus,
  NodeIdentity,
  PanelView,
  ThreadFilter,
} from "./annotation-types.ts";

export { getThreadCount, getThreadsForNode, scrollToNode };

/* ------------------------------------------------------------------ */
/*  Select node helper (pure function, no reactive state)              */
/* ------------------------------------------------------------------ */

/**
 * Create a "select node for comment" handler bound to reactive setters.
 * This is NOT reactive itself — it's a factory that closures over setters.
 */
export function createSelectNodeForComment(
  setSelectedNode: (
    node: {
      nodeId?: string;
      nodePath: string;
      nodeType?: string;
      textSnippet?: string;
    } | null,
  ) => void,
  setPickCandidateNode: (node: null) => void,
  setDraftText: (text: string) => void,
  setHighlightedNode: (node: null) => void,
  setPreviewNode: (node: null) => void,
  setPanelView: (view: string) => void,
  setIsPickingNode: (v: boolean) => void,
) {
  return (node: {
    nodeId?: string;
    nodePath: string;
    nodeType?: string;
    textSnippet?: string;
  }) => {
    setSelectedNode(node);
    setPickCandidateNode(null);
    setDraftText("");
    setHighlightedNode(null);
    setPreviewNode(null);
    setPanelView("composer");
    setIsPickingNode(false);
    scrollToNode(node.nodeId, node.nodePath);
  };
}
