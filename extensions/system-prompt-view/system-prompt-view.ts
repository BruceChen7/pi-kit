/**
 * /system_prompt_view
 *
 * Displays the current system prompt in a read-only TUI view.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  Text,
} from "@earendil-works/pi-tui";

type ThemeLike = {
  fg?: (name: string, text: string) => string;
  heading?: (text: string) => string;
  link?: (text: string) => string;
  linkUrl?: (text: string) => string;
  code?: (text: string) => string;
  codeBlock?: (text: string) => string;
  codeBlockBorder?: (text: string) => string;
  quote?: (text: string) => string;
  quoteBorder?: (text: string) => string;
  hr?: (text: string) => string;
  listBullet?: (text: string) => string;
  bold?: (text: string) => string;
  italic?: (text: string) => string;
  strikethrough?: (text: string) => string;
  underline?: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
  codeBlockIndent?: string;
};

export default function (pi: ExtensionAPI) {
  pi.registerCommand("system_prompt_view", {
    description: "View the current system prompt",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      await ctx.waitForIdle();
      const systemPrompt = ctx.getSystemPrompt();

      if (!systemPrompt) {
        ctx.ui.notify("No system prompt available", "info");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const view = new SystemPromptView(theme, systemPrompt, () => {
          done();
        });

        return {
          render(width: number) {
            return view.render(width);
          },
          invalidate() {
            view.invalidate();
          },
          handleInput(data: string) {
            view.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}

class SystemPromptView implements Component {
  private container: Container;
  private body: Markdown;
  private markdownTheme: MarkdownTheme;
  private scrollY = 0;
  private lines: string[];
  private bodyIndex: number;

  constructor(
    private theme: ThemeLike,
    prompt: string,
    private onClose: () => void,
  ) {
    this.lines = prompt.split("\n");
    this.container = new Container();
    this.markdownTheme = createMarkdownTheme(this.theme);

    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    this.container.addChild(
      new Text(
        theme.fg("accent", theme.bold("System Prompt")) +
          theme.fg(
            "dim",
            ` (${this.lines.length} lines - Esc/q/Enter to close, j/k/arrows to scroll)`,
          ),
        1,
        0,
      ),
    );
    this.container.addChild(new Text("", 1, 0));

    // Add body placeholder, we'll update it dynamically
    // Markdown constructor: (content, x, y, theme, options?)
    this.body = new Markdown("", 1, 0, this.markdownTheme);
    this.bodyIndex = this.container.children.length;
    this.container.addChild(this.body);

    this.container.addChild(new Text("", 1, 0));
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

    this.updateContent();
  }

  private updateContent() {
    const terminalHeight = 24; // Approximate, will be adjusted in render
    const visibleHeight = Math.max(1, terminalHeight - 8);
    const maxScroll = Math.max(0, this.lines.length - visibleHeight);
    this.scrollY = Math.min(this.scrollY, maxScroll);

    const visibleLines = this.lines.slice(
      this.scrollY,
      this.scrollY + visibleHeight,
    );
    const content = visibleLines.join("\n");

    // Replace the Markdown component with a new one containing updated content
    // Markdown constructor: (content, x, y, theme, options?)
    this.container.children[this.bodyIndex] = new Markdown(
      content,
      1,
      0,
      this.markdownTheme,
    );
    this.body = this.container.children[this.bodyIndex] as Markdown;
    this.container.invalidate();
  }

  handleInput(data: string): void {
    const terminalHeight = 24;
    const visibleHeight = Math.max(1, terminalHeight - 8);

    if (
      matchesKey(data, Key.escape) ||
      data.toLowerCase() === "q" ||
      data === "\r"
    ) {
      this.onClose();
      return;
    } else if (matchesKey(data, Key.up) || data.toLowerCase() === "k") {
      this.scrollY = Math.max(0, this.scrollY - 1);
      this.updateContent();
    } else if (matchesKey(data, Key.down) || data.toLowerCase() === "j") {
      const maxScroll = Math.max(0, this.lines.length - visibleHeight);
      this.scrollY = Math.min(maxScroll, this.scrollY + 1);
      this.updateContent();
    } else if (matchesKey(data, Key.pageUp) || data.toLowerCase() === "b") {
      this.scrollY = Math.max(0, this.scrollY - visibleHeight);
      this.updateContent();
    } else if (matchesKey(data, Key.pageDown) || data === " ") {
      const maxScroll = Math.max(0, this.lines.length - visibleHeight);
      this.scrollY = Math.min(maxScroll, this.scrollY + visibleHeight);
      this.updateContent();
    } else if (data.toLowerCase() === "g") {
      this.scrollY = 0;
      this.updateContent();
    } else if (data === "G") {
      const maxScroll = Math.max(0, this.lines.length - visibleHeight);
      this.scrollY = maxScroll;
      this.updateContent();
    }
  }

  invalidate(): void {
    this.container.invalidate();
  }

  render(width: number): string[] {
    return this.container.render(width);
  }
}

function createMarkdownTheme(theme: ThemeLike): MarkdownTheme {
  const identity = (text: string) => text;
  const dim = (text: string) =>
    typeof theme?.fg === "function" ? theme.fg("dim", text) : text;
  const accent = (text: string) =>
    typeof theme?.fg === "function" ? theme.fg("accent", text) : text;

  return {
    heading: theme?.heading ?? accent,
    link: theme?.link ?? accent,
    linkUrl: theme?.linkUrl ?? dim,
    code: theme?.code ?? dim,
    codeBlock: theme?.codeBlock ?? dim,
    codeBlockBorder: theme?.codeBlockBorder ?? dim,
    quote: theme?.quote ?? dim,
    quoteBorder: theme?.quoteBorder ?? dim,
    hr: theme?.hr ?? dim,
    listBullet: theme?.listBullet ?? dim,
    bold: theme?.bold ?? identity,
    italic: theme?.italic ?? identity,
    strikethrough: theme?.strikethrough ?? identity,
    underline: theme?.underline ?? identity,
    highlightCode: theme?.highlightCode,
    codeBlockIndent: theme?.codeBlockIndent,
  };
}
