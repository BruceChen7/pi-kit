import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GlimpseWindow } from "../shared/glimpse-window.ts";
import { writeArtifact } from "./artifact-store.ts";
import visualArtifactExtension from "./index.ts";
import { attachVisualArtifactBridge } from "./ui-bridge.ts";

class FakeGlimpseWindow extends EventEmitter implements GlimpseWindow {
  sent: string[] = [];
  closed = false;

  send(js: string): void {
    this.sent.push(js);
  }

  close(): void {
    this.closed = true;
  }

  emitMessage(message: unknown): void {
    this.emit("message", message);
  }
}

describe("attachVisualArtifactBridge", () => {
  it("loads the extension entry point", () => {
    expect(visualArtifactExtension).toBeTypeOf("function");
  });

  it("sends feedback for the currently selected artifact and acknowledges it", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "visual-artifact-bridge-"),
    );
    const projectName = "test-project";
    const slug = "selected-artifact";
    writeArtifact(projectRoot, projectName, {
      slug,
      title: "Selected artifact",
      nodes: [{ type: "text", props: { text: "Hello" } }],
    });

    const window = new FakeGlimpseWindow();
    let feedbackText = "";
    attachVisualArtifactBridge({
      window,
      projectRoot,
      projectName,
      sendFeedback: async (text) => {
        feedbackText = text;
      },
    });

    window.emitMessage({
      type: "feedback",
      slug,
      items: [{ nodePath: "nodes.0", body: "Please revise this copy." }],
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(feedbackText).toContain("**Slug:** selected-artifact");
    expect(feedbackText).toContain("Please revise this copy.");
    expect(window.sent.at(-1)).toContain("visual-artifact:feedback-sent");
    expect(window.closed).toBe(true);
  });
});
