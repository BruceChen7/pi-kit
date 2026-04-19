import { describe, expect, it } from "vitest";

import { findFeatureBoardCard, parseFeatureBoardFromText } from "./board.js";

describe("feature board parser", () => {
  it("parses feature and child cards from kanban markdown", () => {
    const board = parseFeatureBoardFromText(
      `
## Spec

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->
  - [ ] Split pricing widget <!-- card-id: child-pricing-widget; kind: child; parent: feat-checkout-v2 -->

## Ready

- [ ] Another feature <!-- card-id: another-feature; kind: feature -->
`.trim(),
    );

    expect(board.errors).toEqual([]);
    expect(board.cards.map((card) => card.id)).toEqual([
      "feat-checkout-v2",
      "child-pricing-widget",
      "another-feature",
    ]);
    expect(board.cards[1]).toMatchObject({
      kind: "child",
      parentId: "feat-checkout-v2",
      lane: "Spec",
      depth: 1,
    });
  });

  it("reports parser errors for missing metadata and invalid nesting", () => {
    const board = parseFeatureBoardFromText(
      `
## Spec

- [ ] Broken feature
  - [ ] Broken child <!-- card-id: child-a; kind: child -->
`.trim(),
    );

    expect(board.errors).toEqual([
      "Line 3: missing card-id metadata",
      "Line 4: child card appears before any parent feature",
    ]);
  });

  it("finds cards by id or exact title", () => {
    const board = parseFeatureBoardFromText(
      `
## Inbox

- [ ] Checkout V2 <!-- card-id: feat-checkout-v2; kind: feature -->
`.trim(),
    );

    expect(findFeatureBoardCard(board, "feat-checkout-v2")?.title).toBe(
      "Checkout V2",
    );
    expect(findFeatureBoardCard(board, "Checkout V2")?.id).toBe(
      "feat-checkout-v2",
    );
  });
});
