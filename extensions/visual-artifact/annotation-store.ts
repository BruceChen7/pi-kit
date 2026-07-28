/**
 * Annotation store — persistent annotation threads for artifacts.
 *
 * Each artifact has one annotations.json file.
 * Mutations are serialized per artifact to avoid conflicts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getArtifactBundleDir, getTempDir } from "./paths.ts";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type AnnotationAuthor = {
  name: string;
  email?: string;
};

export type AnnotationAnchor = {
  nodeId: string;
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
    };

export type AnnotationDocument = {
  version: number;
  project: string;
  slug: string;
  threads: AnnotationThread[];
};

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

/**
 * Resolve the path to the annotations.json file for an artifact.
 */
function getAnnotationsPath(
  projectRoot: string,
  projectName: string,
  slug: string,
): string {
  return path.join(
    getArtifactBundleDir(projectRoot, projectName, slug),
    "annotations.json",
  );
}

/**
 * Read annotations document from disk.
 */
export function readAnnotations(
  projectRoot: string,
  projectName: string,
  slug: string,
): AnnotationDocument | null {
  const targetPath = getAnnotationsPath(projectRoot, projectName, slug);
  if (!existsSync(targetPath)) return null;

  try {
    const raw = readFileSync(targetPath, "utf8");
    return JSON.parse(raw) as AnnotationDocument;
  } catch {
    return null;
  }
}

/**
 * Ensure the annotations.json exists for an artifact, creating an empty one if needed.
 */
function ensureAnnotationsExist(
  projectRoot: string,
  projectName: string,
  slug: string,
): AnnotationDocument {
  const existing = readAnnotations(projectRoot, projectName, slug);
  if (existing) return existing;

  const doc: AnnotationDocument = {
    version: 1,
    project: projectName,
    slug,
    threads: [],
  };
  writeAnnotationsAtomic(projectRoot, projectName, slug, doc);
  return doc;
}

/**
 * Apply mutations to an annotation document.
 * Returns the updated document.
 */
export function applyMutations(
  projectRoot: string,
  projectName: string,
  slug: string,
  mutations: AnnotationMutation[],
): AnnotationDocument {
  const doc = ensureAnnotationsExist(projectRoot, projectName, slug);

  for (const mutation of mutations) {
    applyMutation(doc, mutation);
  }

  doc.version += 1;
  writeAnnotationsAtomic(projectRoot, projectName, slug, doc);
  return doc;
}

function applyMutation(
  doc: AnnotationDocument,
  mutation: AnnotationMutation,
): void {
  switch (mutation.type) {
    case "createThread": {
      const thread: AnnotationThread = {
        id: mutation.threadId,
        anchor: mutation.anchor,
        status: "open",
        messages: [
          {
            id: `${mutation.threadId}-msg-1`,
            author: mutation.author,
            body: mutation.body,
            createdAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      doc.threads.push(thread);
      break;
    }

    case "addMessage": {
      const thread = doc.threads.find((t) => t.id === mutation.threadId);
      if (!thread) break;
      thread.messages.push({
        id: mutation.messageId,
        author: mutation.author,
        body: mutation.body,
        createdAt: new Date().toISOString(),
      });
      thread.updatedAt = new Date().toISOString();
      break;
    }

    case "resolveThread": {
      const thread = doc.threads.find((t) => t.id === mutation.threadId);
      if (!thread || thread.status === "resolved") break;
      thread.status = "resolved";
      thread.updatedAt = new Date().toISOString();
      break;
    }

    case "reopenThread": {
      const thread = doc.threads.find((t) => t.id === mutation.threadId);
      if (!thread || thread.status === "open") break;
      thread.status = "open";
      thread.updatedAt = new Date().toISOString();
      break;
    }
  }
}

function writeAnnotationsAtomic(
  projectRoot: string,
  projectName: string,
  slug: string,
  doc: AnnotationDocument,
): void {
  const bundleDir = getArtifactBundleDir(projectRoot, projectName, slug);
  if (!existsSync(bundleDir)) {
    mkdirSync(bundleDir, { recursive: true });
  }

  const targetPath = getAnnotationsPath(projectRoot, projectName, slug);
  const tmpPath = path.join(
    getTempDir(),
    `visual-artifact-annotations-${slug}-${Date.now()}.json`,
  );

  const payload = JSON.stringify(doc, null, 2);
  writeFileSync(tmpPath, payload, "utf8");
  renameSync(tmpPath, targetPath);
}
