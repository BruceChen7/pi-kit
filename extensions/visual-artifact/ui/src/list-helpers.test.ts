import { describe, expect, it } from "vitest";
import {
  dayLabel,
  groupByDay,
  timeLabel,
  typeKey,
  uniqueTypeKeys,
} from "./list-helpers.ts";

describe("typeKey", () => {
  it("maps known node types to display buckets", () => {
    expect(typeKey("mermaid")).toBe("mermaid");
    expect(typeKey("table")).toBe("table");
    expect(typeKey("side-by-side")).toBe("table");
    expect(typeKey("kpi-grid")).toBe("kpi");
    expect(typeKey("accordion")).toBe("accordion");
  });

  it("falls back to text for unknown types", () => {
    expect(typeKey("calldiff-callflow")).toBe("text");
    expect(typeKey("")).toBe("text");
  });
});

describe("uniqueTypeKeys", () => {
  it("keeps first-appearance order and dedupes", () => {
    expect(uniqueTypeKeys(["mermaid", "text", "mermaid", "kpi-grid"])).toEqual([
      "mermaid",
      "text",
      "kpi",
    ]);
  });

  it("caps the number of icons", () => {
    const keys = uniqueTypeKeys(
      ["mermaid", "table", "kpi-grid", "accordion", "text"],
      3,
    );
    expect(keys).toEqual(["mermaid", "table", "kpi"]);
  });

  it("returns an empty list for empty input", () => {
    expect(uniqueTypeKeys([])).toEqual([]);
  });
});

describe("dayLabel", () => {
  const now = new Date("2026-08-13T12:00:00");

  it("labels today and yesterday", () => {
    expect(dayLabel("2026-08-13T09:00:00", now)).toBe("Today");
    expect(dayLabel("2026-08-12T23:00:00", now)).toBe("Yesterday");
  });

  it("labels older dates with a locale date", () => {
    expect(dayLabel("2026-08-04T10:34:00", now)).toBe("Aug 4, 2026");
    expect(dayLabel("2025-12-31T00:00:00", now)).toBe("Dec 31, 2025");
  });

  it("handles invalid timestamps", () => {
    expect(dayLabel("not-a-date", now)).toBe("Unknown");
  });
});

describe("timeLabel", () => {
  it("formats a 12-hour clock time", () => {
    expect(timeLabel("2026-08-13T11:31:00")).toMatch(/11:31 (AM|PM)/u);
  });

  it("returns empty string for invalid timestamps", () => {
    expect(timeLabel("nope")).toBe("");
  });
});

describe("groupByDay", () => {
  const now = new Date("2026-08-13T12:00:00");
  const artifacts = [
    { slug: "a", createdAt: "2026-08-13T09:00:00" },
    { slug: "b", createdAt: "2026-08-12T09:00:00" },
    { slug: "c", createdAt: "2026-08-04T09:00:00" },
    { slug: "d", createdAt: "2026-08-13T10:00:00" },
  ];

  it("groups into ordered day buckets preserving input order", () => {
    const groups = groupByDay(artifacts, now);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Aug 4, 2026",
    ]);
    expect(groups[0].items.map((a) => a.slug)).toEqual(["a", "d"]);
    expect(groups[1].items.map((a) => a.slug)).toEqual(["b"]);
  });

  it("returns an empty list for empty input", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});
