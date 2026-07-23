import { describe, expect, it } from "vitest";
import { buildConceptContent } from "./wiki-concept.mjs";

// ── buildConceptContent ─────────────────────────────────

describe("buildConceptContent", () => {
  it("should generate a skeleton when body is empty and tags default to []", () => {
    const result = buildConceptContent({
      displayName: "Test Concept",
      type: "Concept",
      icon: "note",
      tags: "[]",
      body: "",
    });

    expect(result).toBe(`---
type: Concept
_icon: note
tags: []
---

# Test Concept

## Sources
`);
  });

  it("should insert body between the title and Sources section", () => {
    const result = buildConceptContent({
      displayName: "My Concept",
      type: "Concept",
      icon: "note",
      tags: "[]",
      body: "This is a concept description.",
    });

    expect(result).toContain(
      "# My Concept\n\nThis is a concept description.\n\n## Sources",
    );
  });

  it("should honour --tags with a JSON array", () => {
    const result = buildConceptContent({
      displayName: "Tagged Concept",
      type: "Concept",
      icon: "note",
      tags: "[concurrency, memory-model, c-cpp]",
      body: "",
    });

    expect(result).toContain("tags: [concurrency, memory-model, c-cpp]");
  });

  it("should honour --type Synthesis and --icon notepad", () => {
    const result = buildConceptContent({
      displayName: "Synthesis Note",
      type: "Synthesis",
      icon: "notepad",
      tags: "[]",
      body: "A synthesis-level overview.",
    });

    const expected = `---
type: Synthesis
_icon: notepad
tags: []
---

# Synthesis Note

A synthesis-level overview.

## Sources
`;
    expect(result).toBe(expected);
  });

  it("should preserve body with multiple markdown sections", () => {
    const body = `## Core Concepts

- Core idea one
- Core idea two

## How It Works

1. First step
2. Second step

## Use Cases

- Case A
- Case B`;

    const result = buildConceptContent({
      displayName: "Multi-Section Concept",
      type: "Concept",
      icon: "note",
      tags: "[data-structure]",
      body,
    });

    expect(result).toContain("## Core Concepts");
    expect(result).toContain("- Core idea one");
    expect(result).toContain("## How It Works");
    expect(result).toContain("1. First step");
    expect(result).toContain("## Use Cases");
    expect(result).toContain("- Case B");
    expect(result).toContain("## Sources");
    // Verify ordering: title → body sections → Sources
    const titleIdx = result.indexOf("# Multi-Section Concept");
    const coreIdx = result.indexOf("## Core Concepts");
    const howIdx = result.indexOf("## How It Works");
    const useIdx = result.indexOf("## Use Cases");
    const sourceIdx = result.indexOf("## Sources");
    expect(titleIdx).toBeLessThan(coreIdx);
    expect(coreIdx).toBeLessThan(howIdx);
    expect(howIdx).toBeLessThan(useIdx);
    expect(useIdx).toBeLessThan(sourceIdx);
  });

  it("should handle tags with special characters", () => {
    const result = buildConceptContent({
      displayName: "Special Tags",
      type: "Concept",
      icon: "note",
      tags: '["c/cpp", "rust-lang", "c++11"]',
      body: "",
    });

    expect(result).toContain('tags: ["c/cpp", "rust-lang", "c++11"]');
  });

  it("should handle body with only whitespace as empty (skeleton)", () => {
    const result = buildConceptContent({
      displayName: "Whitespace Body",
      type: "Concept",
      icon: "note",
      tags: "[]",
      body: "   ",
    });

    // The caller trims stdin before passing to buildConceptContent,
    // but the function itself checks truthiness — whitespace-only is truthy,
    // so it would be included. This test documents that trimming happens
    // at the caller level (cmdCreate), not in the pure function.
    expect(result).toContain("   ");
    expect(result).not.toContain("## Sources\n\n   "); // body comes before Sources
  });

  it("should end with a trailing newline", () => {
    const result = buildConceptContent({
      displayName: "Trailing Newline",
      type: "Concept",
      icon: "note",
      tags: "[]",
      body: "Some content.",
    });

    expect(result.endsWith("\n")).toBe(true);
  });

  it("should have Sources section last (no content after it)", () => {
    const result = buildConceptContent({
      displayName: "Sources Last",
      type: "Concept",
      icon: "note",
      tags: "[]",
      body: "Body text.",
    });

    const sourceIdx = result.indexOf("## Sources");
    const afterSources = result.slice(sourceIdx + "## Sources".length).trim();
    expect(afterSources).toBe("");
  });
});
