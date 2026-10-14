import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  createPickerState,
  filterOptions,
  type PickerOption,
} from "../shared/picker-core.ts";
import { applyPickerKey } from "../shared/picker-input.ts";
import {
  type PickerComponent,
  renderPickerLines,
} from "../shared/picker-view.ts";
import { customPanel, hasRichUi, uiHostProfile } from "../shared/rich-ui.ts";

/**
 * Extension that seeds the prompt editor history with recent prompts from the
 * current session and other sessions started in the same working directory.
 */
const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;

interface PromptEntry {
  text: string;
  timestamp: number;
}

type SessionMessageContent = {
  type: string;
  text?: string;
};

type SessionMessage = {
  role?: string;
  content?: string | SessionMessageContent[];
  timestamp?: string | number;
};

type SessionEntry = {
  type?: string;
  message?: SessionMessage;
  timestamp?: string | number;
};

class HistoryEditor extends CustomEditor {
  private lockedBorder = false;
  private _borderColor?: (text: string) => string;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
  ) {
    super(tui, theme, keybindings);
    delete (this as { borderColor?: (text: string) => string }).borderColor;
    Object.defineProperty(this, "borderColor", {
      get: () => this._borderColor ?? ((text: string) => text),
      set: (value: (text: string) => string) => {
        if (this.lockedBorder) return;
        this._borderColor = value;
      },
      configurable: true,
      enumerable: true,
    });
  }

  lockBorderColor() {
    this.lockedBorder = true;
  }
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  const text = content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");

  // Filter out skill tag blocks to avoid searching system prompts
  // Format: <skill name="..." location="...">...</skill>
  const skillTagRegex = /<skill\s+[^>]*>[\s\S]*?<\/skill>/gi;
  const filtered = text.replace(skillTagRegex, "");

  // Filter out extension-generated prompts (e.g., review guidelines from review.ts)
  // These are system prompts injected by extensions that shouldn't appear in history search
  const extensionPromptPatterns = [
    /^# Review Guidelines\s*\n/i, // REVIEW_RUBRIC from review.ts
  ];

  for (const pattern of extensionPromptPatterns) {
    if (pattern.test(filtered)) {
      return "";
    }
  }

  return filtered.trim();
}

function collectUserPromptsFromEntries(entries: SessionEntry[]): PromptEntry[] {
  const prompts: PromptEntry[] = [];

  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry?.message;
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const text = extractText(message.content);
    if (!text) continue;
    const timestamp = Number(
      message.timestamp ?? entry.timestamp ?? Date.now(),
    );
    prompts.push({ text, timestamp });
  }

  return prompts;
}

function getSessionDirForCwd(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(os.homedir(), ".pi", "agent", "sessions", safePath);
}

async function readTail(
  filePath: string,
  maxBytes = 256 * 1024,
): Promise<string> {
  let fileHandle: fs.FileHandle | undefined;
  try {
    const stats = await fs.stat(filePath);
    const size = stats.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";

    const buffer = Buffer.alloc(length);
    fileHandle = await fs.open(filePath, "r");
    const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
    if (bytesRead === 0) return "";
    let chunk = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = chunk.indexOf("\n");
      if (firstNewline !== -1) {
        chunk = chunk.slice(firstNewline + 1);
      }
    }
    return chunk;
  } catch {
    return "";
  } finally {
    await fileHandle?.close();
  }
}

async function loadPromptHistoryForCwd(
  cwd: string,
  excludeSessionFile?: string,
): Promise<PromptEntry[]> {
  const sessionDir = getSessionDirForCwd(path.resolve(cwd));
  const resolvedExclude = excludeSessionFile
    ? path.resolve(excludeSessionFile)
    : undefined;
  const prompts: PromptEntry[] = [];

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch {
    return prompts;
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const filePath = path.join(sessionDir, entry.name);
        try {
          const stats = await fs.stat(filePath);
          return { filePath, mtimeMs: stats.mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );

  const sortedFiles = files
    .filter((file): file is { filePath: string; mtimeMs: number } =>
      Boolean(file),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of sortedFiles) {
    if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude)
      continue;

    const tail = await readTail(file.filePath);
    if (!tail) continue;
    const lines = tail.split("\n").filter(Boolean);
    for (const line of lines) {
      let entry: SessionEntry | undefined;
      try {
        entry = JSON.parse(line) as SessionEntry;
      } catch {
        continue;
      }
      if (entry?.type !== "message") continue;
      const message = entry?.message;
      if (message?.role !== "user" || !Array.isArray(message.content)) continue;
      const text = extractText(message.content);
      if (!text) continue;
      const timestamp = Number(
        message.timestamp ?? entry.timestamp ?? Date.now(),
      );
      prompts.push({ text, timestamp });
      if (prompts.length >= MAX_RECENT_PROMPTS) break;
    }
    if (prompts.length >= MAX_RECENT_PROMPTS) break;
  }

  return prompts;
}

function buildHistoryList(
  currentSession: PromptEntry[],
  previousSessions: PromptEntry[],
): PromptEntry[] {
  const all = [...currentSession, ...previousSessions];
  all.sort((a, b) => a.timestamp - b.timestamp);

  const seen = new Set<string>();
  const deduped: PromptEntry[] = [];
  for (const prompt of all) {
    const key = `${prompt.timestamp}:${prompt.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(prompt);
  }

  return deduped.slice(-MAX_HISTORY_ENTRIES);
}

let loadCounter = 0;

function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp)
      return false;
  }
  return true;
}

function createBorderColor(
  editor: HistoryEditor,
  theme: Theme,
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>,
): (text: string) => string {
  const bashBorderColor = theme.getBashModeBorderColor();
  let thinkingBorderColor = theme.getThinkingBorderColor(getThinkingLevel());

  return (text: string) => {
    if (editor.getText().trimStart().startsWith("!")) {
      return bashBorderColor(text);
    }

    try {
      thinkingBorderColor = theme.getThinkingBorderColor(getThinkingLevel());
    } catch {
      // Keep using the last known thinking border color when the old session
      // runtime has been invalidated during reload or session replacement.
    }

    return thinkingBorderColor(text);
  };
}

function setEditorHistory(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  history: PromptEntry[],
) {
  const uiTheme = ctx.ui.theme;

  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = new HistoryEditor(tui, theme, keybindings);
    editor.borderColor = createBorderColor(editor, uiTheme, () =>
      pi.getThinkingLevel(),
    );
    editor.lockBorderColor();
    for (const prompt of history) {
      editor.addToHistory(prompt.text);
    }
    return editor;
  });
}

function applyEditorWithHistory(pi: ExtensionAPI, ctx: ExtensionContext) {
  // The editor component and its history only exist where the host owns the
  // input widget; a native RPC client (and pi-web) has its own.
  // 这些宿主改用 `/history` 面板 + `setEditorText`（见 registerHistoryCommand）。
  if (!uiHostProfile(ctx).editorComponent) return;

  const sessionFile = ctx.sessionManager.getSessionFile();
  const initialPrompts = collectUserPromptsFromEntries(
    ctx.sessionManager.getBranch(),
  );
  const immediateHistory = buildHistoryList(initialPrompts, []);

  const currentLoad = ++loadCounter;
  const initialText = ctx.ui.getEditorText();
  setEditorHistory(pi, ctx, immediateHistory);

  void (async () => {
    const previousPrompts = await loadPromptHistoryForCwd(
      ctx.cwd,
      sessionFile ?? undefined,
    );
    if (currentLoad !== loadCounter) return;
    if (ctx.ui.getEditorText() !== initialText) return;

    const latestPrompts = collectUserPromptsFromEntries(
      ctx.sessionManager.getBranch(),
    );
    const history = buildHistoryList(latestPrompts, previousPrompts);
    if (historiesMatch(history, immediateHistory)) return;
    setEditorHistory(pi, ctx, history);
  })();
}

/**
 * Web 宿主（pi-web）没有 `setEditorComponent`：拿不到输入组件，但**能**写输入框。
 * 所以把历史做成一个 `/history` 面板，选中后回填（`setEditorText`），
 * 并保留 TUI 上的上箭头历史（两条路互不影响）。
 *
 * 读不到草稿（`editorText.read === false`）时仍然安全：这里不依赖旧草稿值。
 */
function registerHistoryCommand(pi: ExtensionAPI): void {
  // 嵌入运行时/测试替身可能没有命令注册（同 confluence 的写法）。
  if (typeof pi.registerCommand !== "function") return;

  pi.registerCommand("history", {
    description: "Pick a previous prompt and put it back in the editor",
    handler: async (_args, ctx) => {
      if (!hasRichUi(ctx)) {
        ctx.ui.notify("History picker requires an interactive host", "warning");
        return;
      }
      if (typeof ctx.ui.setEditorText !== "function") {
        ctx.ui.notify("This host cannot write to the editor", "warning");
        return;
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      const current = collectUserPromptsFromEntries(
        ctx.sessionManager.getBranch(),
      );
      const previous = await loadPromptHistoryForCwd(
        ctx.cwd,
        sessionFile ?? undefined,
      );
      // 新的在前：buildHistoryList 负责去重与排序，直接复用它的结果。
      const history = buildHistoryList(current, previous);
      if (history.length === 0) {
        ctx.ui.notify("No prompt history for this folder yet", "info");
        return;
      }

      const picked = await pickHistoryPrompt(ctx, history);
      if (picked === undefined) return;
      ctx.ui.setEditorText(picked.text);
      ctx.ui.notify("Prompt restored — edit and send.", "info");
    },
  });
}

/** 历史面板：纯展示 + 回填（复用共享 picker 的 Core）。 */
const pickHistoryPrompt = (
  ctx: ExtensionContext,
  history: PromptEntry[],
): Promise<PromptEntry | undefined> =>
  customPanel<PromptEntry | undefined>(ctx, (tui, _theme, _kb, done, host) => {
    const rows: PickerOption[] = history.map((entry, index) => {
      const label = truncateToWidth(entry.text.replaceAll("\n", " "), 96, "…");
      return { id: String(index), label, value: label };
    });
    let state = createPickerState();
    const visible = (): PickerOption[] => filterOptions(rows, state.query);
    const component: PickerComponent = {
      focused: true,
      render: (width: number) =>
        renderPickerLines({
          title: `Prompt history (${rows.length})`,
          options: visible(),
          state,
          width,
          multiSelect: false,
          focused: component.focused,
          chrome: host.chrome,
          emitCursorMarker: host.wantsFocusMarker,
          footer: "↑/↓ 选择  type 过滤  enter 回填  esc 取消",
          emptyText: "没有匹配的历史",
        }),
      invalidate: () => {},
      handleInput: (data: string) => {
        const action = applyPickerKey(data, state, visible().length);
        if (action.kind === "cancel") {
          done(undefined);
          return;
        }
        if (action.kind === "submit") {
          const row = visible()[action.index];
          done(row ? history[Number(row.id)] : undefined);
          return;
        }
        if (action.kind === "update") state = action.state;
        tui.requestRender();
      },
    };
    return component;
  });

export default function (pi: ExtensionAPI) {
  registerHistoryCommand(pi);

  pi.on("session_start", (_event, ctx) => {
    applyEditorWithHistory(pi, ctx);
  });

  pi.on("session_shutdown", () => {
    loadCounter += 1;
  });
}
