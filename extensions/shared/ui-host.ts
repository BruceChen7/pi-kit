/**
 * ui-host — 宿主能力档案（Functional Core：value in / value out，无 IO）。
 *
 * 不能只判 `ctx.mode`：`mode === "rpc"` 只说明传输层不是 TUI。pi 自带 rpc-mode 的
 * `custom()` 不问宿主就 resolve `undefined`，pi-web 报同样的 `mode: "rpc"` 却真的
 * 实现了组件面板。
 *
 * 取值逐条核对过 pi-web@0.12.1：`ctx.ui` 见 `lib/rpc-manager.ts:1859-1985`，去框见
 * `lib/ansi.ts:58-88`，headless TUI 见 `lib/custom-ui-terminal.ts:1-27`。升级后要
 * 重新核对，不一致就改这里。
 */

/** pi-web 官方文档化的同进程标记（版本化命名空间）。 */
export const PI_WEB_HOST_SYMBOL = Symbol.for(
  "@agegr/pi-web/session-liveness/v1",
);

export type UiHostKind = "tui" | "pi-web" | "generic-rpc" | "headless";

/** 面板外框策略：boxed = 自绘盒子（TUI）；borderless = 宿主自带外框（pi-web）。 */
export type PanelChrome = "boxed" | "borderless";

/** 面板宽度：dynamic = 由 render(width) 决定；数字 = 宿主固定列数。 */
export type PanelWidth = number | "dynamic";

export type WidgetSurfaces = {
  /** `setWidget(key, string[])`。 */
  lines: boolean;
  /** `setWidget(key, factory)`。 */
  factory: boolean;
  placements: "both" | "above" | "none";
  /** widget 内容在**不互动**时是否已经可见。 */
  contentVisibleWithoutInteraction: boolean;
  /**
   * 宿主**自己**在 widget 挂载时展开的“短 widget”行数区间；null = 从不自动展开。
   *
   * pi-web 只在数组由空变非空的那一刻判定一次，所以想让它默认展开的 widget 在
   * 那一次挂载时就得是 2..3 行。
   */
  autoExpandedLines: { min: number; max: number } | null;
};

export type UiHostProfile = {
  kind: UiHostKind;
  /** `ctx.ui.custom()` 会真的把组件画出来并回传 `done()` 的值。 */
  customPanels: boolean;
  widgets: WidgetSurfaces;
  /** `select` / `confirm` / `input` / `editor` / `notify` / `setStatus`。 */
  dialogs: boolean;
  panelChrome: PanelChrome;
  panelWidth: PanelWidth;
  /** 宿主渲染前会调用 `component.invalidate()`。 */
  callsInvalidate: boolean;
  /** 宿主会设置 `component.focused`（决定要不要发 CURSOR_MARKER）。 */
  setsFocused: boolean;
  /** `ctx.ui.theme` 带颜色；false 时调用方应换 kit 的 ANSI 主题。 */
  themeColors: boolean;
  /** `getEditorText()`（读输入框草稿）与 `setEditorText()/pasteToEditor()`（写）。 */
  editorText: { read: boolean; write: boolean };
  /** `setEditorComponent()`（换掉宿主输入组件）。 */
  editorComponent: boolean;
  /** `addAutocompleteProvider()`。 */
  autocomplete: boolean;
  /** `setFooter()` / `setHeader()`。false 时改用 widget（belowEditor / aboveEditor）。 */
  footerHeader: boolean;
  /** `tui.stop()/start()`：把前台终端让给子进程（$EDITOR / nvim）。 */
  terminalSuspend: boolean;
  /** 宿主反给组件的 `tui.terminal`；dynamic = 真实终端尺寸。 */
  terminal: { columns: number; rows: number } | "dynamic";
  /** 宿主会做去框/去光标标记之类的行后处理（pi-web 会）。 */
  panelNormalizesFrame: boolean;
};

export type UiHostInput = {
  mode?: string | undefined;
  hasUI?: boolean | undefined;
  /** `globalThis[PI_WEB_HOST_SYMBOL]`，Shell 读出来传进来。 */
  piWebMarker?: { version?: unknown } | undefined;
  /** `PI_KIT_UI_HOST`：tui | pi-web | rpc | headless。 */
  envOverride?: string | undefined;
};

const TUI_HOST: UiHostProfile = {
  kind: "tui",
  customPanels: true,
  widgets: {
    lines: true,
    factory: true,
    placements: "both",
    contentVisibleWithoutInteraction: true,
    autoExpandedLines: null,
  },
  dialogs: true,
  panelChrome: "boxed",
  panelWidth: "dynamic",
  callsInvalidate: true,
  setsFocused: true,
  themeColors: true,
  editorText: { read: true, write: true },
  editorComponent: true,
  autocomplete: true,
  footerHeader: true,
  terminalSuspend: true,
  terminal: "dynamic",
  panelNormalizesFrame: false,
};

const PI_WEB_HOST: UiHostProfile = {
  kind: "pi-web",
  customPanels: true,
  widgets: {
    lines: true,
    factory: true,
    placements: "both",
    contentVisibleWithoutInteraction: false,
    autoExpandedLines: { min: 2, max: 3 },
  },
  dialogs: true,
  panelChrome: "borderless",
  panelWidth: 92,
  callsInvalidate: false,
  setsFocused: false,
  themeColors: false,
  editorText: { read: false, write: true },
  editorComponent: false,
  autocomplete: false,
  footerHeader: false,
  terminalSuspend: false,
  terminal: { columns: 92, rows: 40 },
  panelNormalizesFrame: true,
};

/**
 * 其余原生 RPC 宿主：`custom()` 存在但不问宿主就 resolve `undefined`，所以只能信
 * 对话框与字符串 widget。
 */
const GENERIC_RPC_HOST: UiHostProfile = {
  kind: "generic-rpc",
  customPanels: false,
  widgets: {
    lines: true,
    factory: false,
    placements: "both",
    contentVisibleWithoutInteraction: true,
    autoExpandedLines: null,
  },
  dialogs: true,
  panelChrome: "boxed",
  panelWidth: "dynamic",
  callsInvalidate: true,
  setsFocused: true,
  themeColors: true,
  // 读草稿不信任：静默默认值就是 Waku 陷阱的一种。
  editorText: { read: false, write: true },
  // 需要宿主拥有输入/终端的能力：没有实测依据就按没有处理。
  editorComponent: false,
  autocomplete: false,
  footerHeader: false,
  terminalSuspend: false,
  terminal: "dynamic",
  panelNormalizesFrame: false,
};

const HEADLESS_HOST: UiHostProfile = {
  kind: "headless",
  customPanels: false,
  widgets: {
    lines: false,
    factory: false,
    placements: "none",
    contentVisibleWithoutInteraction: false,
    autoExpandedLines: null,
  },
  dialogs: false,
  panelChrome: "boxed",
  panelWidth: "dynamic",
  callsInvalidate: false,
  setsFocused: false,
  themeColors: false,
  editorText: { read: false, write: false },
  editorComponent: false,
  autocomplete: false,
  footerHeader: false,
  terminalSuspend: false,
  terminal: "dynamic",
  panelNormalizesFrame: false,
};

const HOST_PROFILES: Record<UiHostKind, UiHostProfile> = {
  tui: TUI_HOST,
  "pi-web": PI_WEB_HOST,
  "generic-rpc": GENERIC_RPC_HOST,
  headless: HEADLESS_HOST,
};

/** 档案是共享只读常量：返回同一个对象，调用方不必复制。 */
export const profileForHostKind = (kind: UiHostKind): UiHostProfile =>
  HOST_PROFILES[kind];

/** `PI_KIT_UI_HOST` 的解析（大小写不敏感，无法识别时返回 undefined）。 */
export const parseUiHostOverride = (
  raw: string | undefined,
): UiHostKind | undefined => {
  switch (raw?.trim().toLowerCase()) {
    case "tui":
      return "tui";
    case "pi-web":
    case "piweb":
      return "pi-web";
    case "rpc":
    case "generic-rpc":
      return "generic-rpc";
    case "headless":
    case "json":
    case "print":
      return "headless";
    default:
      return undefined;
  }
};

/**
 * 判定入口（纯函数）。
 *
 * 顺序：环境变量逃生口 → `hasUI === false` → `mode`。
 * `mode` 缺失或无法识别时按 TUI 处理：这正是旧 `hasRichUi` 的既有约定
 * （直接嵌入扩展运行时的调用方与测试都不传 `mode`）。
 */
export const resolveUiHostProfile = (input: UiHostInput): UiHostProfile => {
  const override = parseUiHostOverride(input.envOverride);
  if (override) return profileForHostKind(override);

  if (input.hasUI === false) return HEADLESS_HOST;

  const mode = input.mode;
  if (mode === "rpc") {
    return input.piWebMarker?.version === 1 ? PI_WEB_HOST : GENERIC_RPC_HOST;
  }
  if (mode === "json" || mode === "print") return HEADLESS_HOST;
  return TUI_HOST;
};
