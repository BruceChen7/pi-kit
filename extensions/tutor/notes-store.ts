/**
 * notes-store — 会话镜像的 IO 与事件接线（Imperative Shell）。
 *
 * 职责边界：
 * - 持有"本次会话绑定到哪篇笔记"这一状态，并随会话恢复（`pi.appendEntry`）。
 * - 唯一落盘出口：串行锁 + 只追加，永不重写整篇。
 * - 绑定路径由 notes-core 的纯函数算出，这里只做 mkdir/读现有的内容。
 *
 * 命令与工具：
 * - `/md-topic <主题>`：按设置拼出 `<vaultRoot>/<topDir>/<主题>/<主题>.md`，建目录建文件。
 * - `/md-log <路径>`：只链接**已存在**的文件（保留 learn 的安全语义，不因笔误造文件）。
 * - `/md-unlog`：解绑。
 * - `bind_notes` 工具：agent 可调用（`/命令` 只能由人敲，skill 需要自主开篇）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadSettings } from "../shared/settings.ts";
import type { AskDetails } from "./ask-core.ts";
import {
  expandHome,
  formatAnswerBlock,
  formatAssistantBlock,
  formatQuestionBlock,
  formatTopicHeader,
  formatUserBlock,
  isValidTopic,
  messageText,
  resolveTutorSettings,
  stripSkillBlocks,
  type TopicRejection,
  topicDirOf,
  topicNotePath,
} from "./notes-core.ts";
import type { QuizDetails } from "./quiz-core.ts";

const ENTRY_TYPE = "tutor-notes";
const STATUS_KEY = "tutor-notes";
const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

const rejectionHint = (reason: TopicRejection): string => {
  switch (reason) {
    case "empty":
      return "topic must not be empty";
    case "separator":
      return 'topic must not contain "/" or "\\"';
    case "parent":
      return 'topic must not contain ".."';
    default:
      return "topic must not contain NUL";
  }
};

type NotesDeps = {
  cwd: string;
  home: string;
};

const resolveSettings = (deps: NotesDeps) => {
  const settings = resolveTutorSettings(loadSettings(deps.cwd).merged);
  return {
    ...settings,
    vaultRoot: expandHome(settings.vaultRoot, deps.home),
  };
};

/** IO 薄边界（导出以便集成测试直接打到真实文件系统）。 */
export const ensureTopicNote = (file: string): { created: boolean } => {
  fs.mkdirSync(topicDirOf(file), { recursive: true });
  if (fs.existsSync(file)) return { created: false };
  fs.writeFileSync(
    file,
    formatTopicHeader(path.basename(file, ".md")),
    "utf-8",
  );
  return { created: true };
};

/**
 * 只追加：读现有内容后在末尾接上。只规整末尾空行，绝不改动已有正文
 * （笔记是学习者的产物，镜像失败或反复绑定都不能损坏它）。
 */
export const appendToNote = (file: string, text: string): void => {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const body = current.replace(/\n+$/, "");
  const prefix = body.length > 0 ? "\n\n" : "";
  fs.writeFileSync(file, `${body}${prefix}${text}\n`, "utf-8");
};

/** `/md-log` 的安全语义：只链接已存在的文件，不因笔误在 vault 里造文件。 */
export const checkExistingFile = (
  file: string,
): { ok: true } | { ok: false; error: string } =>
  fs.existsSync(file) && fs.statSync(file).isFile()
    ? { ok: true }
    : { ok: false, error: `file does not exist: ${file}` };

export const registerNotes = (pi: ExtensionAPI): void => {
  let noteFile: string | null = null;
  let writeLock: Promise<void> = Promise.resolve();
  const loggedQuestions = new Set<string>();

  const withLock = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const previous = writeLock;
    let release: () => void = () => {};
    writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(fn).finally(() => release());
  };

  /** 唯一落盘出口：读现有内容后在末尾追加，外部删文件不影响会话。 */
  const appendBlock = async (text: string): Promise<void> => {
    const target = noteFile;
    if (!target) return;
    await withLock(() => {
      try {
        appendToNote(target, text);
      } catch {
        // 外部删掉/改权限：静默忽略，绝不因为镜像失败打断教学。
      }
    });
  };

  const setStatus = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_KEY,
      noteFile ? `📝 ${path.basename(noteFile)}` : undefined,
    );
  };

  const bind = (
    ctx: ExtensionContext,
    file: string,
    options: { create: boolean },
  ): { ok: true; created: boolean } | { ok: false; error: string } => {
    if (options.create) {
      ensureTopicNote(file);
    } else {
      const check = checkExistingFile(file);
      if (check.ok === false) return { ok: false, error: check.error };
    }
    noteFile = file;
    pi.appendEntry(ENTRY_TYPE, { file });
    setStatus(ctx);
    return { ok: true, created: true };
  };

  const bindFromSettings = (
    ctx: ExtensionContext,
    topic: string,
  ): { ok: true; file: string } | { ok: false; error: string } => {
    const check = isValidTopic(topic);
    if (check.ok === false) {
      return { ok: false, error: rejectionHint(check.reason) };
    }
    const settings = resolveSettings({ cwd: ctx.cwd, home: os.homedir() });
    const file = topicNotePath({
      vaultRoot: settings.vaultRoot,
      topDir: settings.topDir,
      topic: check.topic,
    });
    const result = bind(ctx, file, { create: true });
    if (result.ok === false) return { ok: false, error: result.error };
    return { ok: true, file };
  };

  // ── 会话恢复 ──────────────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    let last: { file: string | null } | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        last = entry.data as { file: string | null } | undefined;
      }
    }
    if (last?.file) {
      noteFile = last.file;
      setStatus(ctx);
    }
  });

  // ── 会话文本镜像 ──────────────────────────────────────────────────────────
  pi.on("message_end", async (event, _ctx) => {
    if (!noteFile) return;
    const message = event.message as { role?: string; content?: unknown };
    if (message?.role === "user") {
      const text = stripSkillBlocks(
        messageText(message.content as never).trim(),
      );
      if (text) await appendBlock(formatUserBlock(text));
      return;
    }
    if (message?.role === "assistant") {
      const text = messageText(message.content as never);
      if (text) await appendBlock(formatAssistantBlock(text));
    }
  });

  // quiz 会在 execute 内洗牌：只认 onUpdate 发出的"用户实际看到的顺序"，
  // 并且每个 toolCallId 只写一次。
  pi.on("tool_execution_update", async (event, _ctx) => {
    if (!noteFile || event.toolName !== "quiz") return;
    if (loggedQuestions.has(event.toolCallId)) return;
    const details = event.partialResult?.details as QuizDetails | undefined;
    if (details?.status !== "pending" || details.options.length === 0) return;
    loggedQuestions.add(event.toolCallId);
    await appendBlock(
      formatQuestionBlock({
        kind: "Quiz",
        question: details.question,
        context: details.context,
        options: details.options,
      }),
    );
  });

  // ask 不洗牌：tool_call 的参数就是展示顺序，可以在用户作答前先写问题块。
  pi.on("tool_call", async (event, _ctx) => {
    if (!noteFile || event.toolName !== "ask_user_question") return;
    const input = event.input as Record<string, unknown>;
    const options = Array.isArray(input.options)
      ? (input.options as Array<{ label?: string }>).flatMap((option, index) =>
          typeof option?.label === "string" && option.label.trim()
            ? [{ index: index + 1, label: option.label.trim() }]
            : [],
        )
      : [];
    await appendBlock(
      formatQuestionBlock({
        kind: "Question",
        question: String(input.question ?? ""),
        context: typeof input.details === "string" ? input.details : undefined,
        options,
      }),
    );
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!noteFile || !QA_TOOLS.has(event.toolName)) return;
    const details = (event as { details?: QuizDetails | AskDetails }).details;
    if (!details || details.status === "pending") return;
    await appendBlock(formatAnswerBlock(details));
  });

  // ── 绑定：工具（agent 可调） + 命令（人可敲） ─────────────────────────────
  const BindNotesParams = Type.Object({
    topic: Type.String({
      description:
        "Teaching topic. Becomes both directory and file name under the notes vault (e.g. 分布式共识 → Learn/分布式共识/分布式共识.md).",
    }),
  });

  pi.registerTool({
    name: "bind_notes",
    label: "Bind Topic Notes",
    description:
      "Bind this session's note mirror to the topic's markdown file in the notes vault, creating the directory and file when missing. " +
      "Call it once at the start of a teaching session, then every reply and quiz answer is appended to that same note.",
    parameters: BindNotesParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const settings = resolveSettings({ cwd: ctx.cwd, home: os.homedir() });
      const result = bindFromSettings(ctx, params.topic);
      if (result.ok === false) {
        return {
          content: [
            {
              type: "text" as const,
              text: `bind_notes failed: ${result.error}`,
            },
          ],
          details: { error: result.error },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Bound session notes to ${result.file}\nEvery reply, question and answer is appended to this file (append-only).`,
          },
        ],
        details: {
          path: result.file,
          vaultRoot: settings.vaultRoot,
          topDir: settings.topDir,
          warnings: settings.warnings,
        },
        isError: false,
      };
    },
  });

  pi.registerCommand("md-topic", {
    description: "Bind the session mirror to <vault>/<topDir>/<主题>/<主题>.md",
    handler: async (args, ctx) => {
      const topic = args.trim();
      if (!topic) {
        ctx.ui.notify("Usage: /md-topic <主题>", "warning");
        return;
      }
      const result = bindFromSettings(ctx, topic);
      if (result.ok === false) {
        ctx.ui.notify(`Cannot bind topic note: ${result.error}`, "error");
        return;
      }
      const backfilled = await backfill(ctx);
      ctx.ui.notify(
        `Bound: ${result.file}${backfilled > 0 ? ` (${backfilled} blocks backfilled)` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("md-log", {
    description:
      "Mirror the session to an existing markdown file (never creates one)",
    handler: async (args, ctx) => {
      const target = args.trim();
      if (!target) {
        ctx.ui.notify("Usage: /md-log <filepath>", "warning");
        return;
      }
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(ctx.cwd, target);
      const result = bind(ctx, resolved, { create: false });
      if (result.ok === false) {
        ctx.ui.notify(`Cannot bind: ${result.error}`, "error");
        return;
      }
      const backfilled = await backfill(ctx);
      ctx.ui.notify(
        `Linked: ${resolved}${backfilled > 0 ? ` (${backfilled} blocks backfilled)` : ""}`,
        "info",
      );
    },
  });

  pi.registerCommand("md-unlog", {
    description: "Stop mirroring the session to the linked markdown file",
    handler: async (_args, ctx) => {
      if (!noteFile) {
        ctx.ui.notify("No markdown file is linked.", "warning");
        return;
      }
      noteFile = null;
      pi.appendEntry(ENTRY_TYPE, { file: null });
      setStatus(ctx);
      ctx.ui.notify("Unlinked session mirror.", "info");
    },
  });

  /** 链接后回填本次会话已有的内容（只看当前分支）。 */
  async function backfill(ctx: ExtensionContext): Promise<number> {
    const blocks: string[] = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      const message = (
        entry as { message?: { role?: string; content?: unknown } }
      ).message;
      if (!message?.role) continue;
      if (message.role === "user") {
        const text = stripSkillBlocks(
          messageText(message.content as never).trim(),
        );
        if (text) blocks.push(formatUserBlock(text));
        continue;
      }
      if (message.role === "assistant") {
        const text = messageText(message.content as never);
        if (text) blocks.push(formatAssistantBlock(text));
        continue;
      }
      const toolName = (entry as { message?: { toolName?: string } }).message
        ?.toolName;
      if (message.role === "toolResult" && toolName && QA_TOOLS.has(toolName)) {
        const details = (
          entry as { message?: { details?: QuizDetails | AskDetails } }
        ).message?.details;
        if (details && details.status !== "pending") {
          blocks.push(formatAnswerBlock(details));
        }
      }
    }
    if (blocks.length === 0) return 0;
    await appendBlock(blocks.join("\n\n"));
    return blocks.length;
  }
};
