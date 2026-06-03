import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;

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

  fitAddon = new FitAddon();
  terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "bar",
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
  resizeObserver?.disconnect();
  resizeObserver = null;
  terminal?.dispose();
  terminal = null;
  fitAddon = null;
}
