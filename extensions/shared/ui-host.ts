/**
 * ui-host — 宿主能力档案（Functional Core：value in / value out，无 IO）。
 *
 * 为什么不能只判 `ctx.mode`：`mode === "rpc"` 只说明"传输层不是 TUI"，不说明
 * "宿主的 ctx.ui 能做什么"。pi 自带 rpc-mode 的 `custom()` 不问宿主就 resolve
 * `undefined`（extensions/shared/rich-ui.ts 顶部注释里的 Waku 陷阱），而
 * **pi-web 同样报 `mode: "rpc"`，却把 `custom()` 实现成了真的组件面板**
 * （pi-web@0.12.1 `lib/rpc-manager.ts:1957/1733-1806`），还支持 widget 与
 * 对话框。一概拒绝等于把 pi-web 也挡在门外。
 *
 * 所以档案按"宿主身份 + 该身份下实测的 ctx.ui 表面"给出，判定只在这里定义
 * 一次，调用方拿字段，不再各自写 `mode` 判断。
 *
 * 各档案的取值来源（逐条核对过 pi-web@0.12.1 源码，改动前请重新核对）：
 *
 * | 能力                | tui | pi-web | generic-rpc | headless |
 * |---------------------|-----|--------|-------------|----------|
 * | customPanels        | ✅  | ✅     | ❌          | ❌       |
 * | widgets.lines       | ✅  | ✅     | ✅          | ❌       |
 * | widgets.factory     | ✅  | ✅     | ❌          | ❌       |
 * | dialogs             | ✅  | ✅     | ✅          | ❌       |
 * | panelChrome         | boxed | borderless | boxed | —     |
 * | panelWidth          | dynamic | 92  | dynamic     | —        |
 * | setsFocused         | ✅  | ❌     | ✅          | ❌       |
 * | callsInvalidate     | ✅  | ❌     | ✅          | ❌       |
 * | themeColors         | ✅  | ❌     | ✅          | ❌       |
 * | editorText.read     | ✅  | ❌     | ✅          | ❌       |
 * | editorText.write    | ✅  | ✅     | ✅          | ❌       |
 * | editorComponent     | ✅  | ❌     | ✅          | ❌       |
 * | autocomplete        | ✅  | ❌     | ✅          | ❌       |
 * | footerHeader        | ✅  | ❌     | ✅          | ❌       |
 * | terminalSuspend     | ✅  | ❌     | ✅          | ❌       |
 * | terminal            | dynamic | 92×40 | dynamic | —      |
 * | panelNormalizesFrame| ❌  | ✅     | ❌          | ❌       |
 * | widgets.autoExpand  | ❌  | 2..3   | ❌          | ❌       |
 * | widgets.contentVis  | ✅  | ❌     | ✅          | ❌       |
 *
 * pi-web 的实测依据：
 * - `ctx.ui`（真实现 / no-op）：pi-web `lib/rpc-manager.ts:1859-1985`；
 * - custom 面板尺寸：`lib/rpc-manager.ts:1667-1676`（默认 92，只读
 *   `overlayOptions.width`，clamp 40–140）；
 * - headless TUI stub：`lib/custom-ui-terminal.ts:1-27`（92×40，
 *   `kittyProtocolActive: false`，只有 `terminal` + `requestRender`）；
 * - 宿主从不调 `component.invalidate()`、也从不设 `component.focused`：
 *   渲染管线只调 `render(width)`（`lib/rpc-manager.ts:1678-1692`）；
 * - 去框：`lib/ansi.ts:58-88` 会整行丢弃 `^[┌├└╭╰][─┬┴┼]+[┐┤┘╮╯]$` 的行、
 *   剥掉行首 `│`/`┃` 与其后一个空格、剥掉行尾 `│`/`┃`、删掉光标标记
 *   `ESC_pi:c BEL`、去尾空格与首尾空行 → 所以 panelChrome 必须是 borderless；
 * - 颜色：宿主传的是 `PLAIN_TEXT_THEME`（全部返回原文，`lib/rpc-manager.ts:229`），
 *   但面板输出走 `AnsiText`/`ansi_up`（`components/AnsiText.tsx`，支持完整 SGR）
 *   → 所以 themeColors 为 false 时改用 kit 自己的 ANSI 主题才有颜色。
 * - widget 自动展开：pi-web 只在 widget 数组由空变非空（`ExtensionWidgets` 挂载）
 *   的那一刻，展开**首个行数在 2..3 之间**的 widget，之后不再重判
 *   （`components/ExtensionWidgets.tsx` 的 `DEFAULT_EXPANDED_WIDGET_LINES` /
 *   `getDefaultExpandedWidgetKey()` / `useState(() => …)`；
 *   `components/ExtensionStatusBar.tsx` 的 `{widgets.length > 0 ? <ExtensionWidgets …> : statusLine}`）
 *   → 档案字段 `WidgetSurfaces.autoExpandedLines`；想靠它默认展开，就得让 widget
 *   在那一次挂载时是 2..3 行。
 * - widget 内容可见性：pi-web 的 widget 平时只是 shelf 上的一枚 chip，内容要点开才看得到；
 *   而 `setStatus` 的文本一直可见（`components/ExtensionStatusBar.tsx`）→ 档案字段
 *   `WidgetSurfaces.contentVisibleWithoutInteraction`。谁把这当成“该换一种表达方式”的判据由
 *   调用方在 Core 里定，档案这里只报事实。
 *
 * 宿主身份怎么认出来（Shell 负责读，见 rich-ui.ts）：pi-web 与扩展同进程，
 * 它的 README「Extension Session Liveness」导出了一个版本化标记
 * `globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")]`，`version === 1`
 * 即 pi-web。pi-web 不向会话/扩展注入任何 `PI_WEB_*` 环境变量（实测），
 * 所以不能用环境变量冒充身份；`PI_KIT_UI_HOST` 是给未知宿主与测试用的逃生口。
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
  /**
   * widget 内容在**不互动**时是否已经可见。
   *
   * TUI = true（widget 就画在编辑框上下）；pi-web = false（shelf 上只有 chip，内容
   * 要点开）；generic-rpc = true（拿不准就不改变现状）；headless = false（widget 不渲染）。
   * 调用方（Core）拿它决定“该不该把关键信息换到一直可见的地方”，不要把宿主身份
   * 写回调用点。
   */
  contentVisibleWithoutInteraction: boolean;
  /**
   * 宿主**自己**在 widget 挂载时展开的“短 widget”行数区间；null = 从不自动展开。
   *
   * pi-web = `{ min: 2, max: 3 }`，且只在 widget 数组由空变非空的那一刻判定一次：
   * 想让它默认展开的 widget 必须在挂载时就是 2..3 行（pi 的 TUI 不分展开/折叠，
   * 所以这一项只影响外置宿主）。pi-web 改规则时只改这里，调用方读字段、不写
   * `kind === "pi-web"` 的显示判断。详见文件头的 pi-web 实测依据。
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
    // shelf 上只有 chip：内容要点开才看到（setStatus 的文本才是常驻的）。
    contentVisibleWithoutInteraction: false,
    // 只在此刻（数组由空变非空）展开首个 2..3 行的 widget，见 WidgetSurfaces。
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
 * 其余原生 RPC 宿主（Waku 那类）：`hasUI` 为真、`custom()` 存在但**不问宿主就
 * resolve `undefined`**，所以只能信对话框与字符串 widget；编辑器组件、自动补全、
 * 主题、终端让位、输入框草稿一律按"没有"处理（这也是旧 `hasRichUi` 想防的那类宿主）。
 */
const GENERIC_RPC_HOST: UiHostProfile = {
  kind: "generic-rpc",
  customPanels: false,
  widgets: {
    lines: true,
    factory: false,
    placements: "both",
    // 未知宿主：没有实测依据就不改变现状（调用方继续走 widget 路径）。
    contentVisibleWithoutInteraction: true,
    autoExpandedLines: null,
  },
  dialogs: true,
  panelChrome: "boxed",
  panelWidth: "dynamic",
  callsInvalidate: true,
  setsFocused: true,
  themeColors: true,
  // 读草稿不信任（静默默认值就是 Waku 陷阱的一种），写不拦：
  // 旧代码里 `setEditorText` 存在就会调，保持这个行为。
  editorText: { read: false, write: true },
  // 下面这几项是“需要宿主拥有输入/终端”的能力：这种宿主一律按没有处理，
  // 与旧 `hasRichUi === false` 时的行为一致（否则会把面板路径引到真 undefined）。
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
