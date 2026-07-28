/**
 * Simplified feedback types for the Glimpse UI.
 *
 * No more thread/mutation/view/filter complexity.
 * Just what's needed for: pick node → write note → add to list → send all.
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

export type FeedbackItem = {
  nodePath: string;
  body: string;
};
