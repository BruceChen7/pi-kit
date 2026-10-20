/**
 * rich-ui — 扩展与宿主 UI 之间的那一层（Imperative Shell，薄）。
 *
 * 判定交给 `ui-host.ts` 的 `resolveUiHostProfile()`，这里只把档案翻译成宿主不保证
 * 的三样东西（主题、外框、光标标记）一次性交给面板组件；`hasRichUi` 是
 * `profile.customPanels` 的别名。
 */

import type {
  KeybindingsManager,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  type PanelChrome,
  type PanelWidth,
  PI_WEB_HOST_SYMBOL,
  resolveUiHostProfile,
  type UiHostProfile,
} from "./ui-host.ts";

/** 判定只需要这几项；`ExtensionContext` 天然满足。 */
export type RichUiContext = {
  hasUI?: boolean;
  mode?: string;
};

/** 面板拿到的宿主能力（由档案翻译而来，普通数据）。 */
export type PanelHost = {
  chrome: PanelChrome;
  /** 数值 = 宿主固定列数；dynamic = 由 `render(width)` 决定。 */
  width: PanelWidth;
  /** 宿主反给组件的终端行数（pi-web 固定 40）；undefined = 读真实终端。 */
  rows: number | undefined;
  /** 宿主会设置 `focused` / 消费光标标记；false 时别发标记。 */
  wantsFocusMarker: boolean;
};

export type PanelFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (value: T) => void,
  host: PanelHost,
) => Component | Promise<Component>;

export type PanelOptions = {
  overlay?: boolean;
  overlayOptions?: unknown;
  onHandle?: unknown;
};

/**
 * 需要组件面板能力的上下文：只要有 `ui` 就行，真实形状在 internal 处一次性宽入。
 * 不把 `ui.custom` 写进公开类型：宿主与扩展各自的签名宽紧不一，收窄会把调用点逼成
 * 满屏 `as unknown as`。
 */
export type PanelContext = RichUiContext & { ui: unknown };

/** 内部宽入后的真实形状（等于 SDK 的 `ctx.ui.custom`）。 */
type PanelUi = {
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (value: T) => void,
    ) => Component | Promise<Component>,
    options?: PanelOptions,
  ): Promise<T>;
};

const asPanelUi = (ctx: PanelContext): PanelUi => ctx.ui as PanelUi;

const HOST_PROFILE_CACHE = new WeakMap<object, UiHostProfile>();

/** pi-web 的同进程标记；读不到（老版本 / 别的宿主）就当没有。 */
const readPiWebMarker = (): { version?: unknown } | undefined => {
  try {
    const marker = (globalThis as Record<PropertyKey, unknown>)[
      PI_WEB_HOST_SYMBOL
    ];
    return marker && typeof marker === "object"
      ? (marker as { version?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * 宿主能力档案。按 `ctx` 对象记忆化：`ctx` 会随 reload / 会话替换重建，
 * 所以缓存不会跨会话残留（进程内的全局标记本身不会变）。
 */
export const uiHostProfile = (ctx: RichUiContext): UiHostProfile => {
  const key = ctx as object;
  const cached = HOST_PROFILE_CACHE.get(key);
  if (cached) return cached;

  const profile = resolveUiHostProfile({
    mode: ctx.mode,
    hasUI: ctx.hasUI,
    piWebMarker: readPiWebMarker(),
    envOverride: process.env.PI_KIT_UI_HOST,
  });
  HOST_PROFILE_CACHE.set(key, profile);
  return profile;
};

/** 宿主是否真的能显示组件界面（= 档案里的 `customPanels`）。 */
export const hasRichUi = (ctx: RichUiContext): boolean =>
  uiHostProfile(ctx).customPanels;

/**
 * 无色宿主（pi-web 传 PLAIN_TEXT_THEME）下换一套 16 色 ANSI 主题：面板输出由宿主
 * 按 ANSI 渲染（pi-web 用 `ansi_up`），用基本 16 色才能跟随宿主的明暗配色。
 */
const ANSI_FG: Partial<Record<ThemeColor, string>> = {
  accent: "36",
  border: "90",
  borderAccent: "36",
  borderMuted: "90",
  success: "32",
  error: "31",
  warning: "33",
  muted: "90",
  dim: "2",
  mdHr: "90",
  mdCodeBlockBorder: "90",
  mdQuoteBorder: "90",
  mdListBullet: "36",
  mdHeading: "1",
  mdLink: "36",
  mdCode: "33",
  mdLinkUrl: "90",
  toolDiffAdded: "32",
  toolDiffRemoved: "31",
  toolDiffContext: "90",
};

const RESET = "\x1b[0m";

const kitPanelTheme = (host: Theme): Theme =>
  new Proxy(host, {
    get(target, prop, receiver) {
      switch (prop) {
        case "fg":
          return (color: ThemeColor, text: string) => {
            const code = ANSI_FG[color];
            return code ? `\x1b[${code}m${text}${RESET}` : text;
          };
        case "bg":
          // 选中态背景交给终端：反显在明暗主题下都成立。
          return (_color: string, text: string) => `\x1b[7m${text}${RESET}`;
        case "bold":
          return (text: string) => `\x1b[1m${text}\x1b[22m`;
        case "italic":
          return (text: string) => `\x1b[3m${text}\x1b[23m`;
        case "underline":
          return (text: string) => `\x1b[4m${text}\x1b[24m`;
        case "inverse":
          return (text: string) => `\x1b[7m${text}${RESET}`;
        case "strikethrough":
          return (text: string) => `\x1b[9m${text}\x1b[29m`;
        case "getThinkingBorderColor":
        case "getBashModeBorderColor":
          return () => (text: string) => text;
        default:
          break;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** 宿主主题有色就原样用；无色才换 kit 的 ANSI 主题。 */
export const themeFor = (profile: UiHostProfile, hostTheme: Theme): Theme => {
  if (profile.themeColors) return hostTheme;
  try {
    return kitPanelTheme(hostTheme);
  } catch {
    return hostTheme;
  }
};

/** 面板行的目标宽度（宿主固定列数时不依赖 `tui.terminal`）。 */
export const panelWidthFor = (
  profile: UiHostProfile,
  fallback: number,
): number =>
  typeof profile.panelWidth === "number" ? profile.panelWidth : fallback;

/**
 * 打开一个组件面板：`ctx.ui.custom()` + 档案适配（主题 / 外框 / 光标标记）。
 * 调用方拿到 `host` 后把它交给渲染器（如 `renderPickerLines` 的 `chrome`）。
 *
 * `undefined` 语义不变：宿主没画成（factory 抛错、返回非组件、会话销毁）时
 * `custom()` 会给 `undefined`，调用方必须把它当"没有选择"。
 */
export const customPanel = async <T>(
  ctx: PanelContext,
  factory: PanelFactory<T>,
  options?: PanelOptions,
): Promise<T> => {
  const profile = uiHostProfile(ctx);
  const host: PanelHost = {
    chrome: profile.panelChrome,
    width: profile.panelWidth,
    rows:
      typeof profile.terminal === "object" ? profile.terminal.rows : undefined,
    wantsFocusMarker: profile.setsFocused,
  };
  return asPanelUi(ctx).custom<T>(
    (tui, theme, keybindings, done) =>
      factory(tui, themeFor(profile, theme), keybindings, done, host),
    options,
  );
};
