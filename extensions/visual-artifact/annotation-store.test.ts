import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnnotationMutation } from "./annotation-store.ts";
import {
  applyMutations,
  applyMutationsToDoc,
  createEmptyAnnotations,
  getOrCreateAnnotations,
  readAnnotations,
  readAnnotationsFlat,
} from "./annotation-store.ts";
import { deleteArtifact, writeArtifact } from "./artifact-store.ts";

const TEST_ROOT = path.join(
  process.cwd(),
  ".test-tmp",
  "annotation-store-test",
);
const TEST_PROJECT = "test-project";
const TEST_SLUG = "test-annotation";

const sampleSpec = {
  slug: TEST_SLUG,
  title: "Annotation Test",
  nodes: [{ type: "text", props: { text: "Hello.", size: "md" } }],
};

const defaultAuthor = { name: "Test User", email: "test@example.com" };
const NOW = "2025-01-15T10:30:00.000Z";

/* ------------------------------------------------------------------ */
/*  Pure core tests — no IO, no mocks                                 */
/* ------------------------------------------------------------------ */

describe("createEmptyAnnotations", () => {
  it("creates an empty annotation document", () => {
    const doc = createEmptyAnnotations("proj", "slug-1");
    expect(doc.project).toBe("proj");
    expect(doc.slug).toBe("slug-1");
    expect(doc.version).toBe(1);
    expect(doc.threads).toHaveLength(0);
  });
});

describe("applyMutationsToDoc", () => {
  it("creates a thread", () => {
    const doc = createEmptyAnnotations("p", "s");
    const updated = applyMutationsToDoc(
      doc,
      [
        {
          type: "createThread",
          threadId: "t1",
          anchor: { nodeId: "n1", nodeType: "text" },
          author: { name: "A" },
          body: "Hello",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    expect(updated.threads).toHaveLength(1);
    expect(updated.threads[0].id).toBe("t1");
    expect(updated.threads[0].status).toBe("open");
    expect(updated.threads[0].createdAt).toBe(NOW);
    expect(updated.threads[0].updatedAt).toBe(NOW);
    expect(updated.threads[0].messages).toHaveLength(1);
    expect(updated.threads[0].messages[0].body).toBe("Hello");
    expect(updated.threads[0].messages[0].createdAt).toBe(NOW);
    expect(updated.version).toBe(2);
  });

  it("adds a message to an existing thread", () => {
    const doc = createEmptyAnnotations("p", "s");
    applyMutationsToDoc(
      doc,
      [
        {
          type: "createThread",
          threadId: "t1",
          anchor: { nodeId: "n1" },
          author: { name: "A" },
          body: "First",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    const updated = applyMutationsToDoc(
      doc,
      [
        {
          type: "addMessage",
          threadId: "t1",
          messageId: "m2",
          author: { name: "B" },
          body: "Reply",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    expect(updated.threads).toHaveLength(1);
    expect(updated.threads[0].messages).toHaveLength(2);
    expect(updated.threads[0].messages[1].body).toBe("Reply");
    expect(updated.threads[0].messages[1].createdAt).toBe(NOW);
    expect(updated.threads[0].updatedAt).toBe(NOW);
    expect(updated.version).toBe(3);
  });

  it("resolves and reopens a thread", () => {
    const doc = createEmptyAnnotations("p", "s");
    applyMutationsToDoc(
      doc,
      [
        {
          type: "createThread",
          threadId: "t1",
          anchor: { nodeId: "n1" },
          author: { name: "A" },
          body: "Fix needed",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    const resolved = applyMutationsToDoc(
      doc,
      [{ type: "resolveThread", threadId: "t1" } satisfies AnnotationMutation],
      NOW,
    );
    expect(resolved.threads[0].status).toBe("resolved");
    expect(resolved.threads[0].updatedAt).toBe(NOW);
    expect(resolved.version).toBe(3);

    const reopened = applyMutationsToDoc(
      doc,
      [{ type: "reopenThread", threadId: "t1" } satisfies AnnotationMutation],
      NOW,
    );
    expect(reopened.threads[0].status).toBe("open");
    expect(reopened.threads[0].updatedAt).toBe(NOW);
    expect(reopened.version).toBe(4);
  });

  it("does nothing when resolving an already-resolved thread", () => {
    const doc = createEmptyAnnotations("p", "s");
    applyMutationsToDoc(
      doc,
      [
        {
          type: "createThread",
          threadId: "t1",
          anchor: { nodeId: "n1" },
          author: { name: "A" },
          body: "x",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    applyMutationsToDoc(
      doc,
      [{ type: "resolveThread", threadId: "t1" } satisfies AnnotationMutation],
      NOW,
    );
    const vBefore = doc.version;
    const alreadyResolved = applyMutationsToDoc(
      doc,
      [{ type: "resolveThread", threadId: "t1" } satisfies AnnotationMutation],
      "2025-02-01T00:00:00.000Z",
    );

    // Status stays resolved, version still increments (mutation applied even if no-op)
    expect(alreadyResolved.threads[0].status).toBe("resolved");
    expect(alreadyResolved.version).toBe(vBefore + 1);
    // updatedAt is NOT changed — the in-place guard skips the write
    expect(alreadyResolved.threads[0].updatedAt).toBe(NOW);
  });

  it("does nothing for an unknown thread", () => {
    const doc = createEmptyAnnotations("p", "s");
    const updated = applyMutationsToDoc(
      doc,
      [
        {
          type: "resolveThread",
          threadId: "nonexistent",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );
    expect(updated.threads).toHaveLength(0);
    expect(updated.version).toBe(2);
  });

  it("applies multiple mutations in a single batch", () => {
    const doc = createEmptyAnnotations("p", "s");
    const updated = applyMutationsToDoc(
      doc,
      [
        {
          type: "createThread",
          threadId: "t1",
          anchor: { nodeId: "n1" },
          author: { name: "A" },
          body: "First",
        } satisfies AnnotationMutation,
        {
          type: "createThread",
          threadId: "t2",
          anchor: { nodeId: "n2" },
          author: { name: "B" },
          body: "Second",
        } satisfies AnnotationMutation,
        { type: "resolveThread", threadId: "t1" } satisfies AnnotationMutation,
      ],
      NOW,
    );

    expect(updated.threads).toHaveLength(2);
    expect(updated.threads[0].status).toBe("resolved");
    expect(updated.threads[1].status).toBe("open");
    expect(updated.version).toBe(2);
  });

  it("edits a message body", () => {
    const doc = createEmptyAnnotations("p", "s");
    applyMutationsToDoc(
      doc,
      [
        {
          type: "createThread",
          threadId: "t1",
          anchor: { nodeId: "n1" },
          author: { name: "A" },
          body: "Original text",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    const edited = applyMutationsToDoc(
      doc,
      [
        {
          type: "editMessage",
          threadId: "t1",
          messageId: doc.threads[0].messages[0].id,
          body: "Edited text",
        } satisfies AnnotationMutation,
      ],
      "2025-02-01T00:00:00.000Z",
    );

    expect(edited.threads).toHaveLength(1);
    expect(edited.threads[0].messages).toHaveLength(1);
    expect(edited.threads[0].messages[0].body).toBe("Edited text");
    expect(edited.threads[0].updatedAt).toBe("2025-02-01T00:00:00.000Z");
    expect(edited.version).toBe(3);
  });

  it("does nothing when editing a non-existent message", () => {
    const doc = createEmptyAnnotations("p", "s");
    applyMutationsToDoc(
      doc,
      [
        {
          type: "createThread",
          threadId: "t1",
          anchor: { nodeId: "n1" },
          author: { name: "A" },
          body: "Hello",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    const vBefore = doc.version;
    const edited = applyMutationsToDoc(
      doc,
      [
        {
          type: "editMessage",
          threadId: "t1",
          messageId: "nonexistent-message",
          body: "Noop",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );

    expect(edited.threads[0].messages[0].body).toBe("Hello");
    expect(edited.version).toBe(vBefore + 1);
    // updatedAt unchanged because the guard skips the write
    expect(edited.threads[0].updatedAt).toBe(NOW);
  });

  it("does nothing when editing a non-existent thread", () => {
    const doc = createEmptyAnnotations("p", "s");
    const edited = applyMutationsToDoc(
      doc,
      [
        {
          type: "editMessage",
          threadId: "nonexistent",
          messageId: "m1",
          body: "Noop",
        } satisfies AnnotationMutation,
      ],
      NOW,
    );
    expect(edited.threads).toHaveLength(0);
    expect(edited.version).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/*  Integration tests — shell + real filesystem                       */
/* ------------------------------------------------------------------ */

describe("annotation-store (integration)", () => {
  beforeEach(() => {
    // Ensure artifact exists (annotations require an existing artifact)
    writeArtifact(TEST_ROOT, TEST_PROJECT, sampleSpec as never);
  });

  afterEach(() => {
    deleteArtifact(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
  });

  it("creates a thread via mutation", () => {
    const result = applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      {
        type: "createThread",
        threadId: "thread-1",
        anchor: { nodeId: "node-1", nodeType: "text" },
        author: defaultAuthor,
        body: "This is a comment.",
      },
    ]);

    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].status).toBe("open");
    expect(result.threads[0].messages).toHaveLength(1);
    expect(result.threads[0].messages[0].body).toBe("This is a comment.");
    expect(result.version).toBeGreaterThanOrEqual(1);
  });

  it("adds a message to a thread", () => {
    const result1 = applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      {
        type: "createThread",
        threadId: "thread-1",
        anchor: { nodeId: "node-1" },
        author: defaultAuthor,
        body: "First comment.",
      },
    ]);

    const threadId = result1.threads[0].id;
    const result2 = applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      {
        type: "addMessage",
        threadId,
        messageId: "msg-2",
        author: defaultAuthor,
        body: "Reply to thread.",
      },
    ]);

    const thread = result2.threads[0];
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1].body).toBe("Reply to thread.");
    expect(result2.version).toBeGreaterThanOrEqual(2);
  });

  it("resolves and reopens a thread", () => {
    const result1 = applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      {
        type: "createThread",
        threadId: "thread-1",
        anchor: { nodeId: "node-1" },
        author: defaultAuthor,
        body: "Needs fix.",
      },
    ]);

    const threadId = result1.threads[0].id;

    const result2 = applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      { type: "resolveThread", threadId },
    ]);
    expect(result2.threads[0].status).toBe("resolved");

    const result3 = applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      { type: "reopenThread", threadId },
    ]);
    expect(result3.threads[0].status).toBe("open");
  });

  it("persists annotations to disk", () => {
    applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      {
        type: "createThread",
        threadId: "persist-thread",
        anchor: { nodeId: "node-1" },
        author: defaultAuthor,
        body: "Will this persist?",
      },
    ]);

    const read = readAnnotations(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    expect(read).not.toBeNull();
    expect(read?.threads).toHaveLength(1);
    expect(read?.threads[0].messages[0].body).toBe("Will this persist?");
    expect(read?.version).toBeGreaterThanOrEqual(1);
  });

  it("returns null for artifact without annotations", () => {
    const read = readAnnotations(TEST_ROOT, TEST_PROJECT, "never-created");
    expect(read).toBeNull();
  });

  it("creates an empty annotation document when requested", () => {
    const created = getOrCreateAnnotations(
      TEST_ROOT,
      TEST_PROJECT,
      "no-annotations",
    );

    expect(created.project).toBe(TEST_PROJECT);
    expect(created.slug).toBe("no-annotations");
    expect(created.threads).toHaveLength(0);

    const read = readAnnotations(TEST_ROOT, TEST_PROJECT, "no-annotations");
    expect(read).not.toBeNull();
    expect(read?.threads).toHaveLength(0);
  });

  it("returns flat annotations for existing threads", () => {
    applyMutations(TEST_ROOT, TEST_PROJECT, TEST_SLUG, [
      {
        type: "createThread",
        threadId: "flat-thread-1",
        anchor: { nodePath: "nodes.0" },
        author: defaultAuthor,
        body: "Comment on nodes.0",
      },
      {
        type: "createThread",
        threadId: "flat-thread-2",
        anchor: { nodePath: "nodes.1" },
        author: defaultAuthor,
        body: "Comment on nodes.1",
      },
    ]);

    const flat = readAnnotationsFlat(TEST_ROOT, TEST_PROJECT, TEST_SLUG);
    expect(flat).toHaveLength(2);
    expect(flat[0]).toEqual({
      nodePath: "nodes.0",
      body: "Comment on nodes.0",
    });
    expect(flat[1]).toEqual({
      nodePath: "nodes.1",
      body: "Comment on nodes.1",
    });
  });

  it("readAnnotationsFlat returns [] for artifact without annotations file", () => {
    const flat = readAnnotationsFlat(TEST_ROOT, TEST_PROJECT, "never-created");
    expect(flat).toEqual([]);
  });
});
