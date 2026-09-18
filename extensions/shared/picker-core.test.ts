import { describe, expect, it } from "vitest";
import {
  createPickerState,
  filterOptions,
  isSubmittable,
  moveCursor,
  PICKER_PAGE_SIZE,
  type PickerOption,
  pageCount,
  pageOf,
  pageSlice,
  resolveSelected,
  setQuery,
  toggleSelection,
} from "./picker-core.ts";

const options: PickerOption[] = [
  { id: "mercury", label: "Mercury", value: "mercury" },
  {
    id: "venus",
    label: "Venus",
    value: "venus",
    description: "hottest planet",
  },
  { id: "earth", label: "Earth", value: "earth" },
];

describe("picker-core", () => {
  it("returns every option for an empty query", () => {
    expect(filterOptions(options, "")).toHaveLength(3);
    expect(filterOptions(options, "   ")).toHaveLength(3);
  });

  it("filters case-insensitively on label and description", () => {
    expect(filterOptions(options, "EAR")).toEqual([options[2]]);
    expect(filterOptions(options, "hottest")).toEqual([options[1]]);
    expect(filterOptions(options, "pluto")).toEqual([]);
  });

  it("resets the cursor when the query changes but keeps selections", () => {
    const state = { ...createPickerState(), cursor: 2, selectedIds: ["earth"] };
    expect(setQuery(state, "ear")).toEqual({
      query: "ear",
      cursor: 0,
      selectedIds: ["earth"],
    });
  });

  it("clamps the cursor instead of wrapping", () => {
    const state = createPickerState();
    expect(moveCursor(state, -1, 3).cursor).toBe(0);
    expect(moveCursor(state, 1, 3).cursor).toBe(1);
    expect(moveCursor({ ...state, cursor: 2 }, 1, 3).cursor).toBe(2);
    expect(moveCursor({ ...state, cursor: 5 }, -1, 0).cursor).toBe(0);
  });

  it("returns the same state object when the cursor cannot move", () => {
    const state = createPickerState();
    expect(moveCursor(state, -1, 3)).toBe(state);
  });

  it("replaces the selection in single-select mode", () => {
    const first = toggleSelection(createPickerState(), "mercury", false);
    const second = toggleSelection(first, "earth", false);
    expect(second.selectedIds).toEqual(["earth"]);
    expect(toggleSelection(second, "earth", false)).toBe(second);
  });

  it("toggles in insertion order without duplicates in multi-select mode", () => {
    const first = toggleSelection(createPickerState(), "earth", true);
    const second = toggleSelection(first, "mercury", true);
    expect(second.selectedIds).toEqual(["earth", "mercury"]);
    expect(toggleSelection(second, "earth", true).selectedIds).toEqual([
      "mercury",
    ]);
  });

  it("requires at least one selection to submit", () => {
    expect(isSubmittable(createPickerState())).toBe(false);
    expect(
      isSubmittable(toggleSelection(createPickerState(), "earth", true)),
    ).toBe(true);
  });

  it("computes page numbers from the cursor", () => {
    expect(pageOf(0)).toBe(0);
    expect(pageOf(PICKER_PAGE_SIZE - 1)).toBe(0);
    expect(pageOf(PICKER_PAGE_SIZE)).toBe(1);
    expect(pageOf(-5)).toBe(0);
  });

  it("counts pages and clamps out-of-range page requests", () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(PICKER_PAGE_SIZE)).toBe(1);
    expect(pageCount(PICKER_PAGE_SIZE + 1)).toBe(2);
    // 越界页码夹到末页，而不是返回空
    expect(pageSlice(options, 9, 2)).toEqual(options.slice(2, 4));
    expect(pageSlice(options, -1, 2)).toEqual(options.slice(0, 2));
    expect(pageSlice(options, 1, 2)).toEqual(options.slice(2, 4));
  });

  it("restores selected options in selection order and ignores unknown ids", () => {
    const state = {
      query: "",
      cursor: 0,
      selectedIds: ["earth", "ghost", "mercury"],
    };
    expect(resolveSelected(options, state).map((option) => option.id)).toEqual([
      "earth",
      "mercury",
    ]);
  });
});
