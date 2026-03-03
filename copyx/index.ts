/**
 * copyx - Select and copy multiple assistant messages to clipboard
 *
 * Usage:
 *   pi --extension ./copyx/index.ts
 *   # or copy to ~/.pi/agent/extensions/copyx/index.ts for auto-discovery
 *
 * Commands:
 *   /copyx - Open message selector to select and copy messages
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@mariozechner/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import type { MessageItem } from "./types.js";
import {
  DEFAULT_MAX_MESSAGES,
  PREVIEW_MAX_CHARS,
  PREVIEW_MAX_LINES,
} from "./types.js";

interface AssistantMessageEntry {
  type: "message";
  message: {
    role: "assistant";
    content: Array<
      { type: "text"; text: string } | { type: "image"; source: unknown }
    >;
    usage?: { input: number; output: number };
  };
}

function isAssistantMessage(entry: unknown): entry is AssistantMessageEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as AssistantMessageEntry).type === "message" &&
    (entry as AssistantMessageEntry).message.role === "assistant"
  );
}

function extractTextContent(entry: AssistantMessageEntry): string {
  return entry.message.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("\n\n");
}

function truncatePreview(
  text: string,
  maxLines = PREVIEW_MAX_LINES,
  maxChars = PREVIEW_MAX_CHARS,
): string {
  const lines = text.split("\n").slice(0, maxLines);
  let result = lines.join("\n");
  if (result.length > maxChars) {
    result = `${result.slice(0, maxChars).trimEnd()}...`;
  }
  return result;
}

function getAssistantMessages(
  ctx: ExtensionCommandContext,
  maxMessages = DEFAULT_MAX_MESSAGES,
): MessageItem[] {
  const entries = ctx.sessionManager.getEntries();

  // Collect all assistant messages in reverse order (newest first)
  const assistantMessages: AssistantMessageEntry[] = [];
  for (
    let i = entries.length - 1;
    i >= 0 && assistantMessages.length < maxMessages;
    i--
  ) {
    const entry = entries[i];
    if (isAssistantMessage(entry)) {
      assistantMessages.push(entry);
    }
  }

  // assistantMessages is already newest first due to reverse traversal.
  const totalAssistantCount = entries.filter((e) =>
    isAssistantMessage(e),
  ).length;
  const reversedWithIndex = assistantMessages.map((msg, idx) => {
    return {
      msg,
      index: totalAssistantCount - idx,
      turnsAgo: idx,
    };
  });

  return reversedWithIndex.map(({ msg, index, turnsAgo }) => {
    const fullText = extractTextContent(msg);
    return {
      index,
      preview: truncatePreview(fullText),
      fullText,
      turnsAgo,
    };
  });
}

function buildOutputText(items: MessageItem[]): string {
  return items
    .map((item) => {
      return `[${item.index}] Assistant (${item.turnsAgo} turn${item.turnsAgo !== 1 ? "s" : ""} ago)\n${item.fullText}`;
    })
    .join("\n\n---\n\n");
}

class MessageSelectorComponent implements Component {
  private selected = new Set<number>();
  private selectedIndex = 0;
  private scrollOffset = 0;
  private readonly maxVisibleItems = 8;

  constructor(
    private readonly messages: MessageItem[],
    private readonly tui: TUI,
    private readonly onDone: (value: MessageItem[] | null) => void,
  ) {}

  private getSelectedItems(): MessageItem[] {
    return Array.from(this.selected)
      .sort((a, b) => a - b)
      .map((i) => this.messages[i])
      .filter(Boolean);
  }

  private cancel(): void {
    this.onDone(null);
  }

  private submit(): void {
    this.onDone(this.getSelectedItems());
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.cancel();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.submit();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selectedIndex = Math.min(
        this.messages.length - 1,
        this.selectedIndex + 1,
      );
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "pageup")) {
      this.selectedIndex = Math.max(
        0,
        this.selectedIndex - this.maxVisibleItems,
      );
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "pagedown")) {
      this.selectedIndex = Math.min(
        this.messages.length - 1,
        this.selectedIndex + this.maxVisibleItems,
      );
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.ctrl("a"))) {
      if (this.selected.size === this.messages.length) {
        this.selected.clear();
      } else {
        for (let i = 0; i < this.messages.length; i++) {
          this.selected.add(i);
        }
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "space")) {
      if (this.selected.has(this.selectedIndex)) {
        this.selected.delete(this.selectedIndex);
      } else {
        this.selected.add(this.selectedIndex);
      }
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const boxWidth = Math.max(40, Math.min(width - 2, 120));
    const contentWidth = boxWidth - 4;
    const horizontal = "-".repeat(boxWidth - 2);
    const padToWidth = (line: string): string =>
      line + " ".repeat(Math.max(0, width - visibleWidth(line)));
    const boxLine = (content = ""): string => {
      const text = truncateToWidth(content, contentWidth);
      const right = " ".repeat(Math.max(0, contentWidth - visibleWidth(text)));
      return `| ${text}${right} |`;
    };

    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + this.maxVisibleItems) {
      this.scrollOffset = this.selectedIndex - this.maxVisibleItems + 1;
    }

    const visibleMessages = this.messages.slice(
      this.scrollOffset,
      this.scrollOffset + this.maxVisibleItems,
    );
    const selectedCount = this.selected.size;
    const title =
      selectedCount > 0
        ? `copyx - ${selectedCount} selected`
        : "copyx - select messages";

    lines.push(padToWidth(`+${horizontal}+`));
    lines.push(padToWidth(boxLine(title)));
    lines.push(padToWidth(`+${horizontal}+`));

    for (let i = 0; i < visibleMessages.length; i++) {
      const actualIndex = this.scrollOffset + i;
      const msg = visibleMessages[i];
      const isSelected = this.selected.has(actualIndex);
      const isActive = actualIndex === this.selectedIndex;
      const prefix = isActive ? ">" : " ";
      const check = isSelected ? "x" : " ";
      const header = `${prefix} [${check}] [${msg.index}] Assistant (${msg.turnsAgo} turn${msg.turnsAgo !== 1 ? "s" : ""} ago)`;
      lines.push(padToWidth(boxLine(header)));

      const previewLines = wrapTextWithAnsi(
        msg.preview,
        contentWidth - 4,
      ).slice(0, 2);
      for (const previewLine of previewLines) {
        lines.push(padToWidth(boxLine(`    ${previewLine}`)));
      }
    }

    for (let i = visibleMessages.length; i < this.maxVisibleItems; i++) {
      lines.push(padToWidth(boxLine("")));
      lines.push(padToWidth(boxLine("")));
      lines.push(padToWidth(boxLine("")));
    }

    lines.push(padToWidth(`+${horizontal}+`));
    lines.push(
      padToWidth(
        boxLine(
          "j/k or up/down: move | space: toggle | ctrl+a: all | enter: copy | esc: cancel",
        ),
      ),
    );
    lines.push(padToWidth(`+${horizontal}+`));

    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copyx", {
    description: "Select and copy multiple assistant messages to clipboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const messages = getAssistantMessages(ctx);

      if (messages.length === 0) {
        ctx.ui.notify("No assistant messages to copy", "warning");
        return;
      }

      if (messages.length === 1) {
        // Only one message, copy directly
        const text = buildOutputText([messages[0]]);
        copyToClipboard(text);
        ctx.ui.notify("Copied 1 message to clipboard", "success");
        return;
      }

      // Match answer.ts pattern: use custom interactive TUI and return a result directly.
      const selectedItems = await ctx.ui.custom<MessageItem[] | null>(
        (tui, _theme, _kb, done) => {
          return new MessageSelectorComponent(messages, tui, done);
        },
      );

      if (selectedItems === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      if (selectedItems.length > 0) {
        const text = buildOutputText(selectedItems);
        copyToClipboard(text);
        ctx.ui.notify(
          `Copied ${selectedItems.length} message(s) to clipboard`,
          "success",
        );
        return;
      }

      ctx.ui.notify("No messages selected", "info");
    },
  });
}
