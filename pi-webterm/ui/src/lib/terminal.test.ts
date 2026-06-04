import { describe, expect, it } from "vitest";
import { getCtrlShiftLetterControlChar } from "./ctrl-shift.js";

describe("getCtrlShiftLetterControlChar", () => {
  it("maps Ctrl+Shift+R to the same control char as Ctrl+R", () => {
    expect(
      getCtrlShiftLetterControlChar({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        code: "KeyR",
        key: "R",
      } as KeyboardEvent),
    ).toBe("\x12");
  });

  it("maps all Ctrl+Shift+A-Z letters by code", () => {
    expect(
      getCtrlShiftLetterControlChar({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        code: "KeyA",
        key: "A",
      } as KeyboardEvent),
    ).toBe("\x01");

    expect(
      getCtrlShiftLetterControlChar({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        code: "KeyZ",
        key: "Z",
      } as KeyboardEvent),
    ).toBe("\x1a");
  });

  it("falls back to key when code is unavailable", () => {
    expect(
      getCtrlShiftLetterControlChar({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        code: "",
        key: "B",
      } as KeyboardEvent),
    ).toBe("\x02");
  });

  it("falls back to keyCode for browsers that emit control-style key values", () => {
    expect(
      getCtrlShiftLetterControlChar({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        code: "",
        key: "\f",
        keyCode: 76,
        which: 76,
      } as KeyboardEvent),
    ).toBe("\x0c");
  });

  it("ignores non Ctrl+Shift+letter events", () => {
    expect(
      getCtrlShiftLetterControlChar({
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        code: "KeyR",
        key: "r",
      } as KeyboardEvent),
    ).toBeNull();

    expect(
      getCtrlShiftLetterControlChar({
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        code: "Digit1",
        key: "!",
      } as KeyboardEvent),
    ).toBeNull();
  });
});
