import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { getCtrlShiftLetterControlChar } from "./ctrl-shift.js";

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let globalKeydownCleanup: (() => void) | null = null;
// CSI-u key sequences are sent directly via options.onData and never
// flow through xterm.js's terminal.onData, so no synthetic-follow-up
// suppression is needed.
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

/**
 * Derive the unmodified Unicode code point from a physical key position
 * (event.code).  Needed when Shift is held so we can recover the base
 * character (e.g. codepoint 46 for `.` even though event.key is `>`).
 *
 * Letters and digits are handled by their Key<letter> / Digit<d> codes.
 * Symbol keys use a fixed US-layout mapping (consistent because event.code
 * is the physical key position, independent of keyboard layout).
 */
function getUnshiftedCodePoint(code: string): number {
  if (code.startsWith("Key")) {
    return code.charCodeAt(3) + 32; // "KeyA" (65) → 'a' (97)
  }
  if (code.startsWith("Digit")) {
    return code.charCodeAt(5); // "Digit0" (48) … "Digit9" (57)
  }

  const map: Record<string, number> = {
    Period: 46,
    Comma: 44,
    Slash: 47,
    Semicolon: 59,
    Quote: 39,
    BracketLeft: 91,
    BracketRight: 93,
    Backslash: 92,
    Backquote: 96,
    Minus: 45,
    Equal: 61,
    Space: 32,
  };
  return map[code] ?? -1;
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

    // Build CSI-u sequence for Ctrl+Shift+Letter so the downstream
    // application (Pi agent via tmux) can preserve the Shift modifier.
    //   CSI-u format:  \e[<lowercase_codepoint>;6u
    //   where modifier 6 = Ctrl+Shift = 1 + 1(u0020Shift) + 4(Ctrl).
    //   Codepoint is the LOWERCASE letter (e.g. 97 for Ctrl+Shift+A).
    const codeMatch = event.code?.match(/^Key([A-Z])$/);
    const letter = codeMatch?.[1] ?? null;
    const csiSeq =
      letter !== null ? `\x1b[${letter.toLowerCase().charCodeAt(0)};6u` : null;

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

      // keyup fallback: macOS Brave swallows Ctrl+Shift+letter keydown
      // in certain environments, so we forward on keyup as a fallback.
      ctrlShiftForwardState.set(ctrlChar, "keyup");
      markCtrlShiftHandled(event);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (csiSeq) {
        console.log("[pi-webterm] CSI-u ctrl+shift (keyup fallback)", {
          csiSeq,
          letter,
        });
        options.onData?.(csiSeq);
      }
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
    if (csiSeq) {
      console.log("[pi-webterm] CSI-u ctrl+shift (keydown)", {
        csiSeq,
        letter,
      });
      options.onData?.(csiSeq);
    }
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

    // ── Ctrl+non-letter printable keys ───────────────────────
    // xterm.js Keyboard.ts drops Ctrl+non-letter combinations
    // (Ctrl+., Ctrl+,, Ctrl+/, etc.) because its handleable set is
    // limited to: A-Z (control chars), Space (NUL), 3-8 (ESC..DEL),
    // [/\] (ESC/FS/GS), and @/_ (NUL/US via key check).
    //
    // Everything else falls through with `result.key` undefined,
    // so _keyDown returns true without emitting any data.
    //
    // We need to send a CSI-u (Kitty keyboard protocol) sequence so
    // the downstream application (Pi agent via tmux) can distinguish
    // e.g. Ctrl+. from a plain `.`.  Native terminal emulators send
    // `\e[<codepoint>;<modifier>u` for this purpose.
    if (
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      event.type === "keydown"
    ) {
      if (event.key && event.key.length === 1) {
        const code = event.key.charCodeAt(0);

        // Letters A-Z/a-z are handled by xterm.js → skip
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
          return true;
        }

        // Keys xterm.js maps to control characters (Ctrl only, no Shift)
        if (!event.shiftKey) {
          // Ctrl+Space → NUL
          if (event.keyCode === 32) return true;
          // Ctrl+3-8 → ESC through DEL
          if (event.keyCode >= 51 && event.keyCode <= 56) return true;
          // Ctrl+[/\] → ESC/FS/GS
          if (
            event.keyCode === 219 ||
            event.keyCode === 220 ||
            event.keyCode === 221
          ) {
            return true;
          }
        }

        // Ctrl+@ → NUL, Ctrl+_ → US (handled by xterm.js via key check)
        if (event.key === "@" || event.key === "_") return true;

        // ── Send CSI-u (Kitty protocol) sequence ──────────────
        //
        // CSI-u format:  \e[<codepoint>;<modifier>u
        //   codepoint  – Unicode code point of the UNMODIFIED key
        //                 (e.g. 46 for `.`, 44 for `,`, 47 for `/`)
        //   modifier   – 1-indexed bitmask:
        //                 1 (none), 2 (shift), 3 (alt), 5 (ctrl),
        //                 6 (ctrl+shift), 7 (ctrl+alt), …
        //
        // Without Shift, event.key is already the base character.
        // With Shift, event.key reports the shifted glyph (e.g. `>`
        // for period), so we derive the unshifted codepoint from
        // the physical key position (event.code).
        const csiMod = 1 + (event.shiftKey ? 1 : 0) + 4; // Ctrl = 4
        const codepoint = event.shiftKey
          ? getUnshiftedCodePoint(event.code)
          : code;

        if (codepoint > 0) {
          const csiSeq = `\x1b[${codepoint};${csiMod}u`;
          console.log("[pi-webterm] sending CSI-u:", {
            csiSeq,
            key: event.key,
            code: codepoint,
            modifier: csiMod,
          });
          options.onData?.(csiSeq);
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          return false;
        }
      }
    }

    return true;
  });

  terminal.onData((data) => {
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
