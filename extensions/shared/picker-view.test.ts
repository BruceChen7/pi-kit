import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  createPickerState,
  type PickerOption,
  toggleSelection,
} from "./picker-core.ts";
import { renderPickerLines } from "./picker-view.ts";

const options: PickerOption[] = [
  { id: "a", label: "Alpha", value: "a" },
  { id: "b", label: "Beta", value: "b" },
  { id: "c", label: "Gamma", value: "c" },
];

const render = (
  overrides: Partial<Parameters<typeof renderPickerLines>[0]> = {},
): string[] =>
  renderPickerLines({
    title: "Pick",
    options,
    state: createPickerState(),
    width: 40,
    multiSelect: false,
    ...overrides,
  });

describe("picker-view", () => {
  it("never exceeds the requested width", () => {
    for (const width of [20, 33, 60]) {
      const lines = renderPickerLines({
        title: "Pick a very long title indeed",
        options: [
          {
            id: "long",
            label: "An extremely long option label that must be truncated",
            value: "long",
          },
        ],
        state: createPickerState(),
        width,
        multiSelect: true,
      });
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("truncates long labels with an ellipsis", () => {
    const lines = render({
      width: 24,
      options: [{ id: "long", label: "A".repeat(80), value: "long" }],
    });
    expect(lines.join("\n")).toContain("…");
  });

  it("marks the cursor and the checked option", () => {
    const state = toggleSelection(createPickerState(), "b", false);
    const lines = render({ state }).join("\n");
    expect(lines).toContain("▸");
    expect(lines).toContain("● Beta");
    expect(lines).toContain("○ Alpha");
  });

  it("marks multi-select checkboxes", () => {
    const state = toggleSelection(createPickerState(), "a", true);
    expect(render({ state, multiSelect: true }).join("\n")).toContain(
      "✓ Alpha",
    );
  });

  it("shows the empty text when nothing matches", () => {
    expect(
      render({ options: [], emptyText: "没有匹配项" }).join("\n"),
    ).toContain("没有匹配项");
  });

  it("uses a custom footer when provided", () => {
    expect(
      render({ footer: "space toggle  enter submit" }).join("\n"),
    ).toContain("space toggle  enter submit");
  });
});
