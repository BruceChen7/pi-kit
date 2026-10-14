import { afterEach, describe, expect, it } from "vitest";
import { PluginTogglePicker } from "../plugin-toggle/picker.ts";
import type { PluginEntry } from "../plugin-toggle/types.ts";
import { SkillTogglePicker } from "../skill-toggle/index.ts";
import {
  clearPiWebHost,
  markPiWebHost,
  normalizeCustomPanelLines,
  openPiWebPanel,
  PI_WEB_COLUMNS,
  piWebKeys,
  stripAnsi,
  TUI_CURSOR_MARKER,
} from "./pi-web-host-fixture.ts";
import { createPickerState, filterOptions } from "./picker-core.ts";
import { applyPickerKey } from "./picker-input.ts";
import { renderPickerLines } from "./picker-view.ts";

afterEach(() => {
  clearPiWebHost();
});

const plugin = (name: string): PluginEntry => ({
  name,
  enabledName: name,
  sourcePath: `/tmp/${name}`,
  kind: "directory",
});

/**
 * pi-web 的 chrome 契约：它自带外框，还会撕掉自绘的框。所以 borderless 输出必须
 * “过一遍去框逻辑后原样不变” —— 没有整行被丢、没有行首缩进被吃、没有残留竖线。
 */
const expectChromeSafe = (lines: string[]): void => {
  const normalized = normalizeCustomPanelLines(lines);
  const trimmed = lines.map((line) => line.replace(/\s+$/, ""));
  while (trimmed.length > 0 && stripAnsi(trimmed[0] ?? "").trim() === "") {
    trimmed.shift();
  }
  while (
    trimmed.length > 0 &&
    stripAnsi(trimmed[trimmed.length - 1] ?? "").trim() === ""
  ) {
    trimmed.pop();
  }
  expect(normalized).toEqual(trimmed);

  for (const line of lines) {
    expect(stripAnsi(line)).not.toContain(TUI_CURSOR_MARKER);
    // pi-web 会整行丢掉带角的框线：borderless 不应该产生它们。
    expect(stripAnsi(line).trimEnd()).not.toMatch(/^[┌├└╭╰][─┬┴┼]+[┐┤┘╮╯]$/);
    const plain = stripAnsi(line);
    expect(plain.startsWith("│")).toBe(false);
    expect(plain.trimEnd().endsWith("│")).toBe(false);
    expect(plain.length).toBeLessThanOrEqual(PI_WEB_COLUMNS);
  }
};

const boxedFixture = (width = 60) =>
  renderPickerLines({
    title: "Pick one",
    options: [
      { id: "a", label: "alpha", value: "alpha" },
      { id: "b", label: "beta", value: "beta" },
    ],
    state: createPickerState(),
    width,
    multiSelect: false,
    focused: true,
  });

describe("pi-web host fixture", () => {
  it("keeps the boxed renderer byte-identical to the TUI look", () => {
    const lines = boxedFixture();
    expect(lines[0]?.startsWith("\x1b[2m╭")).toBe(true);
    // 与改动前的 picker-view 逐字一致：整行一次 dim。
    expect(lines.at(-1)).toBe(`\x1b[2m╰${"─".repeat(58)}╯\x1b[0m`);
    // 自绘的盒线正是 pi-web 会撕掉的东西：`├───┤` 与 `╰───╯` 整行消失，
    // 行的左右竖线被剥掉、行首缩进被吃掉 —— 这就是 borderless 存在的理由。
    const normalized = normalizeCustomPanelLines(lines)
      .map(stripAnsi)
      .join("\n");
    expect(lines.map(stripAnsi).join("\n")).toContain("├");
    expect(normalized).not.toContain("├");
    expect(normalized).not.toContain("╰");
  });

  it("renders a borderless picker that survives pi-web's de-framing", () => {
    const lines = renderPickerLines({
      title: "Pick one",
      options: [
        { id: "a", label: "alpha", value: "alpha" },
        { id: "b", label: "beta", value: "beta" },
      ],
      state: createPickerState(),
      width: PI_WEB_COLUMNS,
      multiSelect: false,
      focused: false,
      chrome: "borderless",
      emitCursorMarker: false,
    });
    expectChromeSafe(lines);
    expect(lines.join("\n")).not.toContain(TUI_CURSOR_MARKER);
    expect(lines.map(stripAnsi).join("\n")).not.toContain("│");
  });

  it("keeps the plugin-toggle picker chrome-safe and still toggles", () => {
    const toggled: string[] = [];
    const picker = new PluginTogglePicker(
      [plugin("alpha"), plugin("beta")],
      new Set(["alpha"]),
      (entry) => toggled.push(entry.name),
      () => {},
      () => {},
      "borderless",
    );
    picker.handleInput(piWebKeys.down);
    picker.handleInput(piWebKeys.enter);
    expect(toggled).toEqual(["beta"]);
    expectChromeSafe(picker.render(PI_WEB_COLUMNS));
    expect(picker.render(PI_WEB_COLUMNS).map(stripAnsi).join("\n")).toContain(
      "Plugin Picker",
    );

    // boxed 模式仍必须是改动前那套盒线（TUI 观感不许变）。
    const boxedPicker = new PluginTogglePicker(
      [plugin("alpha")],
      new Set(["alpha"]),
      () => {},
      () => {},
      () => {},
      "boxed",
    );
    const boxedLines = boxedPicker.render(70);
    const innerW = 70 - 2;
    expect(boxedLines[2]).toBe(`\x1b[2m├${"─".repeat(innerW)}┤\x1b[0m`);
    expect(boxedLines.at(-1)).toBe(`\x1b[2m╰${"─".repeat(innerW)}╯\x1b[0m`);
  });

  it("keeps the skill-toggle picker chrome-safe and filterable", () => {
    const picker = new SkillTogglePicker(
      [
        { name: "alpha", description: "first", filePath: "/tmp/alpha" },
        { name: "beta", description: "second", filePath: "/tmp/beta" },
      ],
      new Set(),
      () => {},
      () => {},
      () => {},
      "borderless",
    );
    picker.handleInput("bet");
    expect(picker.render(PI_WEB_COLUMNS).length).toBeGreaterThan(0);
    expectChromeSafe(picker.render(PI_WEB_COLUMNS));
  });
});

describe("pi-web panel contract", () => {
  it("never touches TUI APIs the headless stub does not have", async () => {
    markPiWebHost();
    const picker = await openPiWebPanel((tui, _theme, _kb, done, host) => {
      let state = createPickerState();
      const rows = [
        { id: "a", label: "alpha", value: "alpha" },
        { id: "b", label: "beta", value: "beta" },
      ];
      const view = {
        focused: true,
        render: (width: number) =>
          renderPickerLines({
            title: "Pick",
            options: filterOptions(rows, state.query),
            state,
            width,
            multiSelect: false,
            focused: true,
            chrome: host.chrome,
            emitCursorMarker: host.wantsFocusMarker,
          }),
        invalidate: () => {},
        handleInput: (data: string) => {
          const action = applyPickerKey(
            data,
            state,
            filterOptions(rows, state.query).length,
          );
          if (action.kind === "cancel") done(undefined);
          if (action.kind === "update") state = action.state;
          if (action.kind === "submit") {
            done(filterOptions(rows, state.query)[action.index]?.id);
          }
          tui.requestRender();
        },
      };
      return view;
    });

    expect(picker.forbiddenTouches()).toEqual([]);
    expectChromeSafe(picker.lines());

    picker.input(piWebKeys.down);
    picker.input(piWebKeys.enter);
    expect(await picker.result).toBe("b");
    expect(picker.closed()).toBe(true);
  });

  it("answers undefined instead of crashing when the host cannot render", async () => {
    markPiWebHost();
    const thrown = await openPiWebPanel(() => {
      throw new Error("boom");
    });
    expect(await thrown.result).toBeUndefined();
    expect(thrown.lines()).toEqual([]);

    const notAComponent = await openPiWebPanel(
      () => "nope" as unknown as never,
    );
    expect(await notAComponent.result).toBeUndefined();
  });
});
