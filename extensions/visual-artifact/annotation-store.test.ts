import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMutations, readAnnotations } from "./annotation-store.ts";
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

describe("annotation-store", () => {
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
  });

  it("returns null for artifact without annotations", () => {
    const read = readAnnotations(TEST_ROOT, TEST_PROJECT, "no-annotations");
    expect(read).toBeNull();
  });
});
