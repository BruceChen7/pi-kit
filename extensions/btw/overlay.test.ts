import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  ScrollView,
  type Terminal,
  TuiAltScreen,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { BtwOverlayComponent } from "./overlay.js";

// 真实宿主的滚轮路径：SGR 字节 → TuiAltScreen.handleViewportInput →
// dispatchMouseToOverlay → component.handleMouse。假 Terminal 只提供 stdin/stdout，
// 断言的是「滚一下，overlay 里的答案动了」，不是内部字段。
vi.mock("@earendil-works/pi-coding-agent", () => {
  const identity = (text: string): string => text;
  return {
    getMarkdownTheme: () => ({
      heading: identity,
      link: identity,
      linkUrl: identity,
      code: identity,
      codeBlock: identity,
      codeBlockBorder: identity,
      quote: identity,
      quoteBorder: identity,
      hr: identity,
      listBullet: identity,
      bold: identity,
      italic: identity,
      strikethrough: identity,
      underline: identity,
    }),
  };
});

const identity = (text: string): string => text;

const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bold: identity,
  italic: identity,
  underline: identity,
  strikethrough: identity,
} as unknown as Theme;

class FakeTerminal implements Terminal {
  private onInput: (data: string) => void = () => {};
  readonly written: string[] = [];
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {}
  get kittyProtocolActive(): boolean {
    return false;
  }
  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.written.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
  /** Feed raw terminal bytes down the path real stdin uses. */
  send(data: string): void {
    this.onInput(data);
  }
}

/** `paragraphs` short paragraphs: overflow is deterministic, one paragraph per line. */
const longAnswer = (paragraphs: number): string =>
  Array.from({ length: paragraphs }, (_, i) => `para ${i}`).join("\n\n");

type Mounted = {
  overlay: BtwOverlayComponent;
  /** Streaming: append a paragraph to the live answer. */
  appendAnswer: (paragraph: string) => void;
  /** Wheel over the middle of the overlay. */
  wheelOverOverlay: (direction: "up" | "down", ticks?: number) => void;
  /** Wheel over the transcript below the overlay. */
  wheelOverTranscript: (direction: "up" | "down", ticks?: number) => void;
  /** Visible overlay frame as one string. */
  render: () => string;
  transcriptScrollTop: () => number;
};

function mountOverlay(options: {
  answer: string;
  streaming?: boolean;
}): Mounted {
  let answer = options.answer;
  const exchanges = [{ question: "why", answer: options.answer }];
  const terminal = new FakeTerminal(80, 24);
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const overlay = new BtwOverlayComponent(
    tui,
    PLAIN_THEME,
    {
      readExchanges: () => exchanges,
      readActive: () =>
        options.streaming ? { question: "why", answer, toolName: null } : null,
      readViewIndex: () => 0,
      readCurrent: () => ({
        question: "why",
        answer,
        label: options.streaming ? "answering…" : "1/1",
      }),
      setViewIndex: () => {},
      onSubmit: () => {},
      onDismiss: () => {},
      onCopy: () => {},
      onUnfocus: () => {},
    },
    { chrome: "boxed", rows: undefined },
  );

  const transcript: Component = {
    render: () => Array.from({ length: 200 }, (_, i) => `transcript ${i}`),
    invalidate: () => {},
  };
  const transcriptScroll = new ScrollView(transcript, {
    follow: "end",
    primary: true,
  });
  tui.setLayoutRoot(transcriptScroll);
  tui.start();
  const handle = tui.showOverlay(overlay, {
    width: "78%",
    minWidth: 64,
    maxHeight: "78%",
    anchor: "top-center",
    margin: { top: 1, left: 2, right: 2 },
    nonCapturing: true,
  });
  // A real frame records the overlay layout that mouse hit-testing uses.
  tui.renderNow();
  const bounds = handle.getBounds();

  const wheelAt = (
    screenX: number,
    screenY: number,
    direction: "up" | "down",
    ticks: number,
  ): void => {
    // SGR uses 1-based coordinates; 64/65 are wheel up/down. One event per send,
    // because the renderer parses a single escape sequence per input chunk.
    for (let tick = 0; tick < ticks; tick++) {
      terminal.send(
        `\x1b[<${direction === "up" ? 64 : 65};${screenX + 1};${screenY + 1}m`,
      );
    }
  };

  return {
    overlay,
    appendAnswer: (paragraph) => {
      answer = `${answer}\n\n${paragraph}`;
    },
    wheelOverOverlay: (direction, ticks = 1) => {
      if (!bounds) throw new Error("overlay never rendered");
      wheelAt(
        bounds.col + Math.floor(bounds.width / 2),
        bounds.row + Math.floor(bounds.height / 2),
        direction,
        ticks,
      );
    },
    wheelOverTranscript: (direction, ticks = 1) => {
      // Bottom row of the screen is always below the top-center overlay.
      wheelAt(40, terminal.rows - 1, direction, ticks);
    },
    render: () => overlay.render(terminal.columns).join("\n"),
    transcriptScrollTop: () => transcriptScroll.scrollTop,
  };
}

describe("BtwOverlayComponent wheel scrolling", () => {
  it("scrolls the answer up when the wheel turns over the overlay", () => {
    const { render, wheelOverOverlay } = mountOverlay({
      answer: longAnswer(40),
    });
    expect(render()).toContain("para 39");

    wheelOverOverlay("up", 200);

    const scrolled = render();
    expect(scrolled).not.toContain("para 39");
    expect(scrolled).toContain("You: why");
    expect(scrolled).toContain("para 0");
  });

  it("returns to the tail when the wheel scrolls down past the end", () => {
    const { render, wheelOverOverlay } = mountOverlay({
      answer: longAnswer(40),
    });

    wheelOverOverlay("up", 200);
    wheelOverOverlay("down", 400);

    expect(render()).toContain("para 39");
  });

  it("keeps the user's scroll position while the answer streams", () => {
    const { appendAnswer, render, wheelOverOverlay } = mountOverlay({
      answer: longAnswer(40),
      streaming: true,
    });

    wheelOverOverlay("up", 10);
    expect(render()).not.toContain("para 39");

    appendAnswer("para 40");
    appendAnswer("para 41");

    expect(render()).not.toContain("para 41");
  });

  it("does not scroll the transcript behind the overlay", () => {
    const { transcriptScrollTop, wheelOverOverlay, wheelOverTranscript } =
      mountOverlay({ answer: longAnswer(40) });
    // The transcript starts at the tail; the sanity wheel below moves it up.
    const atTail = transcriptScrollTop();

    wheelOverOverlay("up", 5);
    expect(transcriptScrollTop()).toBe(atTail);

    wheelOverTranscript("up", 5);
    expect(transcriptScrollTop()).toBeLessThan(atTail);
  });
});

describe("BtwOverlayComponent mouse contract", () => {
  it("reports the wheel event as handled", () => {
    const { overlay, wheelOverOverlay } = mountOverlay({
      answer: longAnswer(40),
    });
    wheelOverOverlay("up", 1);
    const wheelEvent: TuiMouseEvent = {
      type: "wheel",
      button: "none",
      x: 31,
      y: 4,
      screenX: 39,
      screenY: 5,
      width: 64,
      height: 18,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: -1,
    };

    expect((overlay as Component).handleMouse?.(wheelEvent)?.handled).toBe(
      true,
    );
  });

  it("leaves the wheel to the transcript when the answer fits", () => {
    const { overlay } = mountOverlay({ answer: "short answer" });
    const wheelEvent: TuiMouseEvent = {
      type: "wheel",
      button: "none",
      x: 31,
      y: 4,
      screenX: 39,
      screenY: 5,
      width: 64,
      height: 18,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: -1,
    };

    expect((overlay as Component).handleMouse?.(wheelEvent)).toBeUndefined();
  });
});
