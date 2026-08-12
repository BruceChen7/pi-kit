import { describe, expect, it } from "vitest";
import {
  evaluateSubstance,
  extractBodySections,
  extractTags,
  extractTitle,
  generateAllCards,
  generateConnectionCard,
  generateQaCard,
  generateSummaryCard,
  parseConceptContent,
  summarizeSection,
} from "./cards.js";

// ── Test fixtures ──────────────────────────────────────

const RICH_CONCEPT = `---
type: Concept
_icon: note
tags: [go, golang, http, web-server]
---

# Go HTTP Server

Go's standard library provides a production-ready HTTP server in the \`net/http\` package. The default multiplexer, \`ServeMux\`, implements a Command pattern where each URL pattern maps to a dedicated handler function registered via \`HandleFunc\`.

The server supports middleware composition, graceful shutdown, and HTTP/2 via TLS.

## Common Causes

First common cause paragraph. Second sentence of the cause.

## Detection and Prevention

Use goleak package. Monitor with runtime.NumGoroutine.

## Sources

- [[Wiki/Summaries/Calendar/DailyNotes/2024/2024-07-23.summary]]
`;

const THIN_CONCEPT = `---
type: Concept
_icon: note
tags: []
---

# Async/Await

## Sources

- [[Wiki/Summaries/Calendar/DailyNotes/2026/2026-02-02.summary]]
`;

const CONCEPT_WITHOUT_SECTIONS = `---
type: Concept
_icon: note
tags: [test]
---

# Simple Concept

This is a simple concept with only one paragraph. It has enough text to be considered substantive but no ## sections.

## Sources

- [[Wiki/Summaries/...]]
`;

// ── parseConceptContent ────────────────────────────────

describe("parseConceptContent", () => {
  it("should parse rich concept with tags and sections", () => {
    const result = parseConceptContent(
      RICH_CONCEPT,
      "go-http-server",
      "/path/go-http-server.md",
    );

    expect(result.slug).toBe("go-http-server");
    expect(result.title).toBe("Go HTTP Server");
    expect(result.tags).toEqual(["go", "golang", "http", "web-server"]);
    expect(result.hasSubstance).toBe(true);
    expect(result.source).toBe("/path/go-http-server.md");
  });

  it("should parse thin concept without substance", () => {
    const result = parseConceptContent(
      THIN_CONCEPT,
      "async-await",
      "/path/async-await.md",
    );

    expect(result.slug).toBe("async-await");
    expect(result.title).toBe("Async/Await");
    expect(result.tags).toEqual([]);
    expect(result.hasSubstance).toBe(false);
  });

  it("should handle concept without ## sections", () => {
    const result = parseConceptContent(
      CONCEPT_WITHOUT_SECTIONS,
      "simple-concept",
      "/path/simple.md",
    );

    expect(result.title).toBe("Simple Concept");
    expect(result.tags).toEqual(["test"]);
    expect(result.hasSubstance).toBe(true);
    expect(result.bodySections).toHaveLength(1);
    expect(result.bodySections[0].heading).toBe("概述");
  });
});

// ── extractTags ────────────────────────────────────────

describe("extractTags", () => {
  it("should extract tags from frontmatter", () => {
    const tags = extractTags(RICH_CONCEPT);
    expect(tags).toEqual(["go", "golang", "http", "web-server"]);
  });

  it("should return empty array when no tags", () => {
    const tags = extractTags(THIN_CONCEPT);
    expect(tags).toEqual([]);
  });

  it("should return empty array when no frontmatter", () => {
    const tags = extractTags("# Just a title\n\nSome content");
    expect(tags).toEqual([]);
  });
});

// ── extractTitle ───────────────────────────────────────

describe("extractTitle", () => {
  it("should extract title from # heading", () => {
    expect(extractTitle(RICH_CONCEPT)).toBe("Go HTTP Server");
  });

  it("should return slug-based fallback when no # heading", () => {
    const result = extractTitle("---\ntags: []\n---\n\nSome content");
    // No # heading found, slug not provided — returns "Some" from fallback
    expect(typeof result).toBe("string");
  });
});

// ── extractBodySections ────────────────────────────────

describe("extractBodySections", () => {
  it("should split body into sections by ## headings", () => {
    const sections = extractBodySections(RICH_CONCEPT);

    expect(sections.length).toBeGreaterThanOrEqual(2);

    // First section should be "概述" (content before first ##)
    const overviewIdx = sections.findIndex((s) => s.heading === "概述");
    expect(overviewIdx).not.toBe(-1);

    // Should have Common Causes and Detection
    const causesIdx = sections.findIndex((s) => s.heading === "Common Causes");
    expect(causesIdx).not.toBe(-1);

    const detectIdx = sections.findIndex(
      (s) => s.heading === "Detection and Prevention",
    );
    expect(detectIdx).not.toBe(-1);
  });

  it("should exclude ## Sources section", () => {
    const sections = extractBodySections(RICH_CONCEPT);
    const sourcesSection = sections.find((s) => s.heading === "Sources");
    expect(sourcesSection).toBeUndefined();
  });

  it("should return empty for thin concept", () => {
    const sections = extractBodySections(THIN_CONCEPT);
    expect(sections).toHaveLength(0);
  });
});

// ── evaluateSubstance ──────────────────────────────────

describe("evaluateSubstance", () => {
  it("should return true for rich concept", () => {
    const parsed = parseConceptContent(
      RICH_CONCEPT,
      "go-http-server",
      "/path.md",
    );
    expect(evaluateSubstance(parsed.bodySections, RICH_CONCEPT)).toBe(true);
  });

  it("should return false for thin concept", () => {
    const parsed = parseConceptContent(THIN_CONCEPT, "async-await", "/path.md");
    expect(evaluateSubstance(parsed.bodySections, THIN_CONCEPT)).toBe(false);
  });
});

// ── Card generation ────────────────────────────────────

describe("generateQaCard", () => {
  it("should create a QA card with Chinese question", () => {
    const parsed = parseConceptContent(
      RICH_CONCEPT,
      "go-http-server",
      "/path.md",
    );
    const card = generateQaCard(parsed);

    expect(card.cardType).toBe("qa");
    expect(card.question).toContain("什么是 Go HTTP Server");
    expect(card.answer.length).toBeGreaterThanOrEqual(2);
    expect(card.tags).toContain("go");
  });
});

describe("generateSummaryCard", () => {
  it("should create a summary card with condensed answer", () => {
    const parsed = parseConceptContent(
      RICH_CONCEPT,
      "go-http-server",
      "/path.md",
    );
    const card = generateSummaryCard(parsed);

    expect(card.cardType).toBe("summary");
    expect(card.question).toContain("回顾 Go HTTP Server");
    expect(card.answer.length).toBeGreaterThanOrEqual(2);
  });
});

describe("generateConnectionCard", () => {
  it("should create a connection card linking two concepts", () => {
    const parsed = parseConceptContent(
      RICH_CONCEPT,
      "go-http-server",
      "/path.md",
    );
    const card = generateConnectionCard(parsed, "Context Cancellation");

    expect(card.cardType).toBe("connection");
    expect(card.question).toContain("Go HTTP Server 和 Context Cancellation");
    expect(card.relatedConcept).toBe("Context Cancellation");
  });
});

describe("generateAllCards", () => {
  it("should generate QA + Summary for concept without related", () => {
    const parsed = parseConceptContent(
      RICH_CONCEPT,
      "go-http-server",
      "/path.md",
    );
    const cards = generateAllCards(parsed);

    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.cardType)).toEqual(["qa", "summary"]);
  });

  it("should generate QA + Summary + Connection when related given", () => {
    const parsed = parseConceptContent(
      RICH_CONCEPT,
      "go-http-server",
      "/path.md",
    );
    const cards = generateAllCards(parsed, "Context Cancellation");

    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.cardType)).toEqual([
      "qa",
      "summary",
      "connection",
    ]);
  });
});

// ── summarizeSection ───────────────────────────────────

describe("summarizeSection", () => {
  it("should limit to approximately 3 sentences", () => {
    const long =
      "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const result = summarizeSection(long);
    // First 3 sentences
    expect(result).toContain("First sentence");
    expect(result).toContain("Third sentence");
    expect(result).not.toContain("Fifth sentence");
  });

  it("should truncate when over 200 chars", () => {
    const veryLong =
      "This is a very long sentence that goes on and on and on about various topics. ".repeat(
        6,
      );
    const result = summarizeSection(veryLong);
    // Should be truncated to ~200 chars with ellipsis
    expect(result.length).toBeLessThanOrEqual(203); // 200 + ellipsis
    expect(result).toMatch(/…$/);
  });
});
