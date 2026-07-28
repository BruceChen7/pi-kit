/**
 * Annotation types for the Glimpse UI.
 *
 * Shared types (AnnotationAuthor, AnnotationAnchor, etc.) are re-exported
 * from the canonical source at extensions/visual-artifact/shared/.
 * Frontend-only types (NodeIdentity, filter/view types) live here.
 */

export type {
  AnnotationAnchor,
  AnnotationAuthor,
  AnnotationDocument,
  AnnotationMessage,
  AnnotationMutation,
  AnnotationThread,
} from "../../../shared/annotation-types.ts";

export type NodeIdentity = {
  nodeId?: string;
  nodePath: string;
  nodeType?: string;
  textSnippet?: string;
};

export type ThreadFilter = "all" | "open" | "resolved";
export type PanelView = "list" | "composer" | "thread";
export type AuthorStatus = "loading" | "ready" | "fallback";
