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
/*  Types — re-exported from shared canonical source                   */
/* ------------------------------------------------------------------ */

export type {
  AnnotationAnchor,
  AnnotationAuthor,
  AnnotationDocument,
  AnnotationMessage,
  AnnotationMutation,
  AnnotationThread,
} from "./shared/annotation-types.ts";

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
 * Create an empty annotation document (pure, no IO).
 */
export function createEmptyAnnotations(
  project: string,
  slug: string,
): AnnotationDocument {
  return { version: 1, project, slug, threads: [] };
}

/**
 * Ensure the annotations.json exists for an artifact, creating an empty one if needed.
 */
export function getOrCreateAnnotations(
  projectRoot: string,
  projectName: string,
  slug: string,
): AnnotationDocument {
  const existing = readAnnotations(projectRoot, projectName, slug);
  if (existing) return existing;

  const doc = createEmptyAnnotations(projectName, slug);
  writeAnnotationsAtomic(projectRoot, projectName, slug, doc);
  return doc;
}

/**
 * Apply a batch of mutations to an in-memory document.
 *
 * This is the pure decision core — no IO, no clock reads.
 * Timestamps must be injected via the `now` parameter.
 */
export function applyMutationsToDoc(
  doc: AnnotationDocument,
  mutations: AnnotationMutation[],
  now: string,
): AnnotationDocument {
  for (const mutation of mutations) {
    applyMutation(doc, mutation, now);
  }
  doc.version += 1;
  return doc;
}

/**
 * Apply mutations to an annotation document, persisting to disk.
 * Returns the updated document.
 */
export function applyMutations(
  projectRoot: string,
  projectName: string,
  slug: string,
  mutations: AnnotationMutation[],
): AnnotationDocument {
  const doc = getOrCreateAnnotations(projectRoot, projectName, slug);
  const now = new Date().toISOString();
  const updated = applyMutationsToDoc(doc, mutations, now);
  writeAnnotationsAtomic(projectRoot, projectName, slug, updated);
  return updated;
}

function applyMutation(
  doc: AnnotationDocument,
  mutation: AnnotationMutation,
  now: string,
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
            createdAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
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
        createdAt: now,
      });
      thread.updatedAt = now;
      break;
    }

    case "resolveThread": {
      const thread = doc.threads.find((t) => t.id === mutation.threadId);
      if (!thread || thread.status === "resolved") break;
      thread.status = "resolved";
      thread.updatedAt = now;
      break;
    }

    case "reopenThread": {
      const thread = doc.threads.find((t) => t.id === mutation.threadId);
      if (!thread || thread.status === "open") break;
      thread.status = "open";
      thread.updatedAt = now;
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
