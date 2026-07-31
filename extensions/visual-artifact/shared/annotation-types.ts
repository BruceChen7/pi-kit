/**
 * Canonical annotation types shared between frontend and backend.
 *
 * The frontend is the data source, so any type differences are resolved
 * in favor of the frontend (e.g. nodeId is optional because the DOM
 * attribute may not be set).
 */

export type AnnotationAuthor = {
  name: string;
  email?: string;
};

export type AnnotationAnchor = {
  nodeId?: string;
  nodePath?: string;
  nodeType?: string;
  textSnippet?: string;
};

export type AnnotationMessage = {
  id: string;
  author: AnnotationAuthor;
  body: string;
  createdAt: string;
  editedAt?: string;
};

export type AnnotationThread = {
  id: string;
  anchor: AnnotationAnchor;
  status: "open" | "resolved";
  messages: AnnotationMessage[];
  createdAt: string;
  updatedAt: string;
};

export type AnnotationMutation =
  | {
      type: "createThread";
      threadId: string;
      anchor: AnnotationAnchor;
      author: AnnotationAuthor;
      body: string;
    }
  | {
      type: "addMessage";
      threadId: string;
      messageId: string;
      author: AnnotationAuthor;
      body: string;
    }
  | {
      type: "resolveThread";
      threadId: string;
    }
  | {
      type: "reopenThread";
      threadId: string;
    }
  | {
      type: "editMessage";
      threadId: string;
      messageId: string;
      body: string;
    };

export type AnnotationDocument = {
  version: number;
  project: string;
  slug: string;
  threads: AnnotationThread[];
};
