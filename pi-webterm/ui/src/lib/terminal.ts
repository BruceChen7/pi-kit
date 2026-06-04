import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { getCtrlShiftLetterControlChar } from "./ctrl-shift.js";

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let globalKeydownCleanup: (() => void) | null = null;
let pendingSyntheticCtrlShiftEscSequence: string | null = null;
const CTRL_SHIFT_HANDLED_FLAG = "__piCtrlShiftHandled" as const;

type CtrlShiftHandledKeyboardEvent = KeyboardEvent & {
  [CTRL_SHIFT_HANDLED_FLAG]?: boolean;
};

function isCtrlShiftDebugEvent(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.shiftKey;
}

function logCtrlShiftDebug(
  source: string,
  event: KeyboardEvent,
  details: Record<string, unknown> = {},
): void {
  if (!isCtrlShiftDebugEvent(event)) {
    return;
  }

  console.log("[pi-webterm] ctrl+shift debug", {
    source,
    type: event.type,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    which: event.which,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    activeElement:
      typeof document !== "undefined" && document.activeElement
        ? (document.activeElement as HTMLElement).tagName
        : null,
    ...details,
  });
}

function markCtrlShiftHandled(event: KeyboardEvent): void {
  (event as CtrlShiftHandledKeyboardEvent)[CTRL_SHIFT_HANDLED_FLAG] = true;
}

function wasCtrlShiftHandled(event: KeyboardEvent): boolean {
  return Boolean(
    (event as CtrlShiftHandledKeyboardEvent)[CTRL_SHIFT_HANDLED_FLAG],
  );
}

export function createTerminal(
  container: HTMLElement,
  options: {
    fontSize?: number;
    theme?: Record<string, string>;
    onData?: (data: string) => void;
    onResize?: (cols: number, rows: number) => void;
  } = {},
): Terminal {
  if (terminal) {
    terminal.dispose();
  }
  resizeObserver?.disconnect();
  resizeObserver = null;
  globalKeydownCleanup?.();
  globalKeydownCleanup = null;
  pendingSyntheticCtrlShiftEscSequence = null;

  fitAddon = new FitAddon();
  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
    macOptionIsMeta: true,
    fontSize: options.fontSize ?? 14,
    fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
    theme: options.theme ?? {
      background: "#1a1a2e",
      foreground: "#e0e0e0",
      cursor: "#00ff00",
      selectionBackground: "#3a3a5e",
      black: "#000000",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#6272a4",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#555555",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#6d8bc9",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
    allowTransparency: false,
    scrollback: 10000,
  });

  terminal.loadAddon(fitAddon);
  terminal.open(container);

  const ctrlShiftForwardState = new Map<string, "keydown" | "keyup">();

  const forwardCtrlShiftLetter = (event: KeyboardEvent): boolean => {
    if (wasCtrlShiftHandled(event)) {
      logCtrlShiftDebug("forward:already-handled", event);
      return false;
    }

    const ctrlChar = getCtrlShiftLetterControlChar(event);
    logCtrlShiftDebug("forward:before", event, {
      matched: Boolean(ctrlChar),
      ctrlChar,
      existingState: ctrlChar ? ctrlShiftForwardState.get(ctrlChar) : null,
    });
    if (!ctrlChar) {
      return false;
    }

    if (event.type === "keyup") {
      const state = ctrlShiftForwardState.get(ctrlChar);
      if (state === "keydown") {
        ctrlShiftForwardState.set(ctrlChar, "keyup");
        markCtrlShiftHandled(event);
        logCtrlShiftDebug("forward:keyup-skip-after-keydown", event, {
          matched: true,
          ctrlChar,
        });
        return false;
      }

      if (state === "keyup") {
        ctrlShiftForwardState.delete(ctrlChar);
        markCtrlShiftHandled(event);
        logCtrlShiftDebug("forward:keyup-duplicate-skip", event, {
          matched: true,
          ctrlChar,
        });
        return false;
      }

      ctrlShiftForwardState.set(ctrlChar, "keyup");
      markCtrlShiftHandled(event);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      pendingSyntheticCtrlShiftEscSequence = `\x1b${ctrlChar}`;
      console.log("[pi-webterm] synthetic ctrl+shift direct send", {
        source: "keyup-fallback",
        ctrlChar,
        suppressedFollowup: pendingSyntheticCtrlShiftEscSequence,
      });
      options.onData?.(ctrlChar);
      logCtrlShiftDebug("forward:keyup-fallback", event, {
        matched: true,
        ctrlChar,
        defaultPreventedAfter: event.defaultPrevented,
      });
      return true;
    }

    if (event.type !== "keydown") {
      return false;
    }

    ctrlShiftForwardState.set(ctrlChar, "keydown");
    markCtrlShiftHandled(event);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    pendingSyntheticCtrlShiftEscSequence = `\x1b${ctrlChar}`;
    console.log("[pi-webterm] synthetic ctrl+shift direct send", {
      source: "keydown",
      ctrlChar,
      suppressedFollowup: pendingSyntheticCtrlShiftEscSequence,
    });
    options.onData?.(ctrlChar);
    logCtrlShiftDebug("forward:after", event, {
      matched: true,
      ctrlChar,
      defaultPreventedAfter: event.defaultPrevented,
    });
    return true;
  };

  // Intercept as early as possible while the terminal textarea has focus.
  // This covers browser/xterm layers before default shortcuts run.
  const textarea = terminal.textarea;
  if (textarea && typeof window !== "undefined") {
    const onWindowKeyEvent = (event: KeyboardEvent) => {
      logCtrlShiftDebug("window:capture", event, {
        textareaFocused: document.activeElement === textarea,
      });
      if (document.activeElement !== textarea) {
        return;
      }
      forwardCtrlShiftLetter(event);
    };
    window.addEventListener("keydown", onWindowKeyEvent, true);
    window.addEventListener("keyup", onWindowKeyEvent, true);
    globalKeydownCleanup = () => {
      window.removeEventListener("keydown", onWindowKeyEvent, true);
      window.removeEventListener("keyup", onWindowKeyEvent, true);
    };
  }

  // ── Ctrl+Shift+letter fix ────────────────────────────────
  // xterm.js ignores Ctrl+Shift+A-Z in Keyboard.ts because the main
  // Ctrl branch requires !ev.shiftKey. Bind the custom key handler
  // after open(), matching xterm.js usage patterns, and forward the
  // same control character as the non-Shift version.
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    logCtrlShiftDebug("xterm:custom-handler", event);
    if (wasCtrlShiftHandled(event)) {
      logCtrlShiftDebug("xterm:custom-handler-skip-handled", event);
      return false;
    }
    if (forwardCtrlShiftLetter(event)) {
      return false;
    }
    return true;
  });

  terminal.onData((data) => {
    console.log("[pi-webterm] terminal.onData raw", {
      data,
      codePoints: Array.from(data).map((char) => char.charCodeAt(0)),
      pendingSyntheticCtrlShiftEscSequence,
    });
    if (
      pendingSyntheticCtrlShiftEscSequence &&
      data === pendingSyntheticCtrlShiftEscSequence
    ) {
      console.log("[pi-webterm] terminal.onData suppressed synthetic follow-up", {
        data,
        codePoints: Array.from(data).map((char) => char.charCodeAt(0)),
      });
      pendingSyntheticCtrlShiftEscSequence = null;
      return;
    }
    pendingSyntheticCtrlShiftEscSequence = null;
    options.onData?.(data);
  });

  // ── Initial fit ────────────────────────────────────────────
  //
  // `fitAddon.fit()` checks the renderer's character cell dimensions
  // (`dimensions.actualCellWidth/Height`).  These are calculated by
  // the renderer AFTER the first frame—**not** when `open()` returns.
  // If we call `fit()` before the renderer is ready, it silently
  // returns a no-op and the terminal stays at default (80×24) size.
  //
  // The reliable approach: subscribe once to `onRender`, which fires
  // after the renderer has initialised and measured the font.  At that
  // point `fit()` will actually resize the terminal.
  let onRenderDisposable: { dispose: () => void } | null = null;
  onRenderDisposable = terminal.onRender(() => {
    fitAddon?.fit();
    if (terminal) {
      console.log(
        `[pi-webterm] terminal fit: container=${container.clientWidth}x${container.clientHeight}` +
          ` cols=${terminal.cols} rows=${terminal.rows}` +
          ` char=${fitAddon ? "ready" : "no-fit"}`,
      );
    }
    terminal?.focus();
    if (terminal) {
      options.onResize?.(terminal.cols, terminal.rows);
    }
    onRenderDisposable?.dispose();
    onRenderDisposable = null;
  });

  // Safety fallback: if onRender never fires (extreme edge case), fit
  // after a generous timeout so the terminal still ends up sized.
  setTimeout(() => {
    if (onRenderDisposable) {
      onRenderDisposable.dispose();
      onRenderDisposable = null;
      fitAddon?.fit();
      terminal?.focus();
      if (terminal) {
        options.onResize?.(terminal.cols, terminal.rows);
      }
    }
  }, 2000);

  // ── Re-fit on container resize ─────────────────────────────
  resizeObserver = new ResizeObserver(() => {
    fitAddon?.fit();
    if (terminal) {
      options.onResize?.(terminal.cols, terminal.rows);
    }
  });
  resizeObserver.observe(container);

  return terminal;
}

export function writeToTerminal(data: string): void {
  terminal?.write(data);
}

export function clearTerminal(): void {
  terminal?.clear();
}

export function resetTerminal(): void {
  terminal?.reset();
}

export function fitTerminal(): void {
  fitAddon?.fit();
}

export function focusTerminal(): void {
  terminal?.focus();
}

export function getTerminal(): Terminal | null {
  return terminal;
}

export function disposeTerminal(): void {
  globalKeydownCleanup?.();
  globalKeydownCleanup = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
}
