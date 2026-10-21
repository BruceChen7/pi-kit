/**
 * FleetView 的会话视图（Shell 组件）。
 *
 * 只做两件事：把 core.renderTranscript 的行画进面板，把输入框里的文字交回
 * 调用方去 steer。判断逻辑（哪些行、什么状态）全在 core/view，不在这里。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { panelPainter } from "../shared/panel-chrome.ts";
import type { PanelChrome } from "../shared/ui-host.ts";

export type FleetOverlayCallbacks = {
  readLines: () => string[];
  onSubmit: (value: string) => void;
  onDismiss: () => void;
};

export type FleetOverlayOptions = {
  chrome: PanelChrome;
  title: string;
  hint: string;
};

export class FleetOverlay implements Component {
  private readonly painter: ReturnType<typeof panelPainter>;
  private readonly input = new Input();
  focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly callbacks: FleetOverlayCallbacks,
    private readonly options: FleetOverlayOptions,
  ) {
    this.painter = panelPainter(options.chrome);
    this.input.onSubmit = (value: string) => {
      this.input.setValue("");
      this.callbacks.onSubmit(value);
    };
  }

  refresh(): void {
    this.tui.requestRender();
  }

  invalidate(): void {
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.callbacks.onDismiss();
      return;
    }
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const paintBorder = (text: string) => this.theme.fg("border", text);
    const innerWidth = this.painter.innerWidth(width);

    const out: string[] = [
      this.painter.titleLine({
        width,
        title: this.options.title,
        paintTitle: (text) => this.theme.fg("accent", text),
        paintBorder,
      }),
    ];

    for (const line of this.callbacks.readLines()) {
      out.push(
        this.painter.rowLine({
          width,
          content: truncateToWidth(line, innerWidth, "…"),
          paintBorder,
        }),
      );
    }

    out.push(this.painter.ruleLine({ width, paintBorder }));

    const previousFocused = this.input.focused;
    this.input.focused = false;
    try {
      const rendered = this.input.render(innerWidth)[0] ?? "";
      out.push(
        this.painter.rowLine({
          width,
          content: truncateToWidth(rendered, innerWidth, ""),
          paintBorder,
        }),
      );
    } finally {
      this.input.focused = previousFocused;
    }

    out.push(
      this.painter.rowLine({
        width,
        content: this.theme.fg("dim", this.options.hint),
        paintBorder,
      }),
    );

    const bottom = this.painter.bottomLine({ width, paintBorder });
    if (bottom) out.push(bottom);

    return out;
  }
}
