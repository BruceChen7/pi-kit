import { describe, expect, it } from "vitest";
import { isRenderableCard, isRenderableNode } from "./renderable-node.ts";

describe("isRenderableNode", () => {
  it("hides empty code blocks", () => {
    expect(isRenderableNode({ type: "code-block", props: { code: "" } })).toBe(
      false,
    );
    expect(
      isRenderableNode({ type: "code-block", props: { code: "   \n" } }),
    ).toBe(false);
  });

  it("keeps non-empty code blocks", () => {
    expect(
      isRenderableNode({
        type: "code-block",
        props: { code: "const ok = true;" },
      }),
    ).toBe(true);
  });

  it("hides untitled cards whose nested nodes are empty", () => {
    expect(
      isRenderableCard({
        nodes: [{ type: "code-block", props: { code: "" } }],
      }),
    ).toBe(false);
  });

  it("keeps cards with a visible nested node", () => {
    expect(
      isRenderableCard({
        nodes: [
          { type: "mermaid", props: { definition: "flowchart LR\nA-->B" } },
        ],
      }),
    ).toBe(true);
  });
});
