/**
 * tutor — 教学系统扩展（单目录 = 一个开关）。
 *
 * 本文件只做接线（Imperative Shell）：注册工具与命令，把参数交给纯核，
 * 把结果包成 pi 的工具返回值。判定、格式化、路径拼装都在 *-core.ts 与 topic-store。
 *
 * 接线顺序有意：tutor-mode 控制器先跑（`registerNotes` 要用它交出的 `enable`，
 * 绑定教学内容后打开闸门）。各模块职责：
 *   quiz / ask（* -core + *-ui）、notes-store（镜像 + 落点 gate）、
 *   concepts-store（概念表）、topic-store（vault 只读）、topic-status（状态查询 + 首轮注入）。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getMermaidParser } from "../shared/mermaid-runtime.ts";
import {
  type AskDetails,
  type AskMode,
  askMode,
  buildAskDetails,
  normalizeAskOptions,
} from "./ask-core.ts";
import { runAsk } from "./ask-ui.ts";
import { registerConcepts } from "./concepts-store.ts";
import {
  detectRenderCapability,
  renderArgs,
  validateMermaidInput,
} from "./diagram-core.ts";
import {
  detectTutorCommand,
  detectTutorSkill,
  formatTutorModeStatus,
  parseTutorModeCommand,
  planToolSync,
  restoreTutorMode,
  TUTOR_MODE_ENTRY_TYPE,
  type TutorMode,
} from "./mode-core.ts";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  QUIZ_TOOL_NAME,
  TUTOR_MODE_COMMAND_NAME,
} from "./names.ts";
import { vaultDirOf } from "./notes-core.ts";
import { registerNotes } from "./notes-store.ts";
import {
  buildOutcome,
  normalizeQuizOptions,
  type QuizDetails,
  type QuizMode,
  type QuizOption,
  resolveCorrectValues,
  shuffle,
} from "./quiz-core.ts";
import { runQuiz } from "./quiz-ui.ts";
import { resolveSettings } from "./settings-store.ts";
import { registerTopicStatus } from "./topic-status.ts";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the answer option." }),
  value: Type.Optional(
    Type.String({
      description:
        "Optional machine-readable value returned for the option. Defaults to the label.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional extra detail shown below the option.",
    }),
  ),
});

const QuizParams = Type.Object({
  question: Type.String({
    description:
      "The single quiz question to ask. Ask exactly one question per tool call.",
  }),
  details: Type.Optional(
    Type.String({
      description:
        "Optional extra context or instructions shown under the question.",
    }),
  ),
  options: Type.Array(OptionSchema, {
    description:
      "The answer options (2 or more). Options only — there is no free-text mode. Give each option a stable `value`; you reference the correct one by that value in correctAnswer.",
    minItems: 2,
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "Set to true when more than one option is correct and the user must select all of them.",
    }),
  ),
  correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "REQUIRED. The correct answer as the option `value`(s) — not a position number. Single-select: one string. Multi-select: an array of strings; the user is correct only if their selection matches that set exactly.",
  }),
  explanation: Type.String({
    description:
      "REQUIRED. Explanation revealed AFTER the user answers (shown whether they were right or wrong).",
  }),
  shuffle: Type.Optional(
    Type.Boolean({
      description:
        "Defaults to true: options are reordered before display so the correct answer is not always in the same position. Set to false only when order is meaningful (e.g. ordered numbers, or an 'All of the above' row that must stay last).",
    }),
  ),
});

const errorResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  isError: true,
});

const quizResult = (details: QuizDetails) => ({
  content: [{ type: "text" as const, text: details.message ?? "" }],
  details,
  isError: false,
});

const registerQuiz = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: QUIZ_TOOL_NAME,
    label: "Quiz",
    description:
      "Ask ONE graded multiple-choice question and reveal the answer afterwards. " +
      "Options only (no free text). Use it to find the edge of the learner's knowledge " +
      "and to confirm a single teaching node actually landed. Never render the correct " +
      "answer or the explanation in the question itself.",
    // 本工具独占终端 UI：任一批里有 sequential，pi 就把整批串行执行
    // （pi-agent-core executeToolCalls），并行发两个提问会把先上屏的组件摘掉。
    executionMode: "sequential",
    parameters: QuizParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      onUpdate,
      ctx: ExtensionContext,
    ) {
      const normalized = normalizeQuizOptions(params.options);
      // 注意：本仓库 tsconfig 为 strict:false，布尔字面量判别联合只能用显式
      // 比较收窄——`if (!normalized.ok)` 不会收窄成 error 分支。
      if (normalized.ok === false) return errorResult(normalized.error);

      const mode: QuizMode = params.multiSelect
        ? "multi-select"
        : "single-select";
      const resolved = resolveCorrectValues(
        params.correctAnswer,
        normalized.options,
      );
      if (resolved.error) return errorResult(resolved.error);
      if (mode === "single-select" && resolved.values.length !== 1) {
        return errorResult(
          `single-select requires exactly one correctAnswer value, got ${resolved.values.length}`,
        );
      }

      const displayed: QuizOption[] =
        params.shuffle === false
          ? normalized.options
          : shuffle(normalized.options);

      const run = await runQuiz(ctx, {
        question: params.question,
        context: params.details,
        options: displayed,
        mode,
        onDisplay: (options) => {
          // 把"用户将看到的顺序"提前发出：md-log 依赖它把问题块写得与屏幕一致。
          const pending = buildOutcome({
            status: "pending",
            question: params.question,
            context: params.details,
            mode,
            options,
          });
          onUpdate?.({
            content: [{ type: "text" as const, text: pending.message ?? "" }],
            details: pending,
          });
        },
      });

      if (run.kind === "unavailable") {
        return quizResult(
          buildOutcome({
            status: "unavailable",
            question: params.question,
            context: params.details,
            mode,
            options: displayed,
            explanation: params.explanation,
          }),
        );
      }
      if (run.kind === "cancelled") {
        return quizResult(
          buildOutcome({
            status: "cancelled",
            question: params.question,
            context: params.details,
            mode,
            options: displayed,
            explanation: params.explanation,
          }),
        );
      }

      return quizResult(
        buildOutcome({
          status: "answered",
          question: params.question,
          context: params.details,
          mode,
          options: displayed,
          selectedValues: run.dontKnow ? [] : run.selectedValues,
          correctValues: resolved.values,
          dontKnow: run.dontKnow,
          explanation: params.explanation,
        }),
      );
    },
  });
};

const registerAsk = (pi: ExtensionAPI): void => {
  const AskParams = Type.Object({
    question: Type.String({
      description:
        "The single question to ask. Use it for forks with no correct answer (learning goal, direction, preference) — for graded questions use `quiz` instead.",
    }),
    details: Type.Optional(
      Type.String({
        description: "Optional extra context shown under the question.",
      }),
    ),
    options: Type.Optional(
      Type.Array(OptionSchema, {
        description:
          "Suggested answers. Omit (or pass none) to ask an open question in free text. An 'Other…' row is always appended so the user can answer in their own words.",
      }),
    ),
    multiSelect: Type.Optional(
      Type.Boolean({ description: "Allow picking more than one option." }),
    ),
  });

  pi.registerTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question",
    description:
      "Ask ONE question with no right answer (goal, direction, preference) and let the user pick an option or answer in their own words. For graded questions use `quiz`.",
    // 同 quiz：独占终端 UI，不能和别的 tool call 并行上屏。
    executionMode: "sequential",
    parameters: AskParams,
    async execute(
      _toolCallId,
      params,
      _signal,
      onUpdate,
      ctx: ExtensionContext,
    ) {
      const options = normalizeAskOptions(params.options);
      const mode: AskMode = askMode(options, params.multiSelect === true);

      const result = (details: AskDetails) => ({
        content: [{ type: "text" as const, text: details.message }],
        details,
        isError: false,
      });

      const base = {
        question: params.question,
        context: params.details,
        mode,
        options,
      };
      if (mode !== "free-text") {
        onUpdate?.({
          content: [
            {
              type: "text" as const,
              text: `waiting for the user to answer: ${params.question}`,
            },
          ],
          details: buildAskDetails({ ...base, status: "pending" }),
        });
      }

      const run = await runAsk(ctx, {
        question: params.question,
        context: params.details,
        options,
        mode,
      });

      if (run.kind === "unavailable")
        return result(buildAskDetails({ ...base, status: "unavailable" }));
      if (run.kind === "cancelled")
        return result(buildAskDetails({ ...base, status: "cancelled" }));
      if (run.kind === "other") {
        return result(
          buildAskDetails({ ...base, status: "answered", otherText: run.text }),
        );
      }
      return result(
        buildAskDetails({
          ...base,
          status: "answered",
          selectedIds: run.selectedIds,
        }),
      );
    },
  });
};

const execFileAsync = promisify(execFile);

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type RenderDetails = {
  ok: boolean;
  render: boolean;
  reason?: string;
  savedPath?: string;
};

/** 统一 render_mermaid 的返回形状：显式类型避免 details 被首个分支固定住。 */
const renderResult = (
  text: string,
  details: RenderDetails,
  image?: ImageContent,
): {
  content: (TextContent | ImageContent)[];
  details: RenderDetails;
  isError: false;
} => ({
  content: image ? [{ type: "text", text }, image] : [{ type: "text", text }],
  details,
  isError: false,
});

const registerDiagram = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "validate_mermaid",
    label: "Validate Mermaid",
    description:
      "Check Mermaid syntax with the real parser (no browser needed). Accepts either a bare diagram or a markdown snippet containing ```mermaid fences. " +
      "Call it before putting a diagram into a lesson note.",
    parameters: Type.Object({
      source: Type.String({
        description: "Mermaid source, or markdown containing mermaid fences.",
      }),
    }),
    async execute(_toolCallId, params) {
      const parser = await getMermaidParser();
      const { results, fromFences } = await validateMermaidInput(
        params.source,
        parser,
      );
      const failures = results.filter((result) => result.ok === false);
      const diagramTypes = results
        .map((result) => result.diagramType)
        .filter((type): type is string => typeof type === "string");

      if (failures.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Mermaid OK${diagramTypes.length > 0 ? ` (${diagramTypes.join(", ")})` : ""}${fromFences ? ` — ${results.length} block(s)` : ""}.`,
            },
          ],
          details: { ok: true, blocks: results.length, diagramTypes },
          isError: false,
        };
      }

      const lines = failures.map((failure, index) => {
        const errors = failure.ok === false ? failure.errors : [];
        return [
          `block ${index + 1}:`,
          ...errors.map((error) => `  - ${error}`),
        ].join("\n");
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Mermaid validation failed.\n\n${lines.join("\n")}`,
          },
        ],
        details: { ok: false, blocks: results.length, diagramTypes },
        isError: false,
      };
    },
  });

  pi.registerTool({
    name: "render_mermaid",
    label: "Render Mermaid",
    description:
      "Render Mermaid to a PNG so you can LOOK at it before shipping the diagram. Requires the `mmdc` CLI — when it is missing the call degrades to a skip notice instead of failing. " +
      "Pass `savePath` to keep the PNG (e.g. next to the note); otherwise the image is only returned for inspection.",
    parameters: Type.Object({
      source: Type.String({ description: "Mermaid source to render." }),
      savePath: Type.Optional(
        Type.String({
          description:
            "Optional absolute path to save the PNG to (parent directories are created).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-mermaid-"));
      const inputPath = path.join(dir, "diagram.mmd");
      const outputPath = path.join(dir, "diagram.png");
      fs.writeFileSync(inputPath, params.source, "utf-8");

      try {
        await execFileAsync("mmdc", renderArgs({ inputPath, outputPath }), {
          timeout: 120_000,
        });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENOENT") {
          const capability = detectRenderCapability(false);
          const reason =
            capability.render === false
              ? capability.reason
              : "mmdc-unavailable";
          return renderResult(
            `Render skipped (${reason}): mmdc is not on PATH. Validate the diagram with validate_mermaid and ship the fence — Obsidian renders it.`,
            { ok: false, render: false, reason },
          );
        }
        const stderr = String(
          (error as { stderr?: string }).stderr ?? "",
        ).trim();
        return renderResult(
          `Mermaid render FAILED — fix the source and try again.\n\n${stderr || String((error as Error).message)}`,
          { ok: false, render: true },
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }

      const savedPath = params.savePath
        ? path.resolve(params.savePath)
        : undefined;
      const data = fs.readFileSync(outputPath).toString("base64");
      if (savedPath) {
        fs.mkdirSync(path.dirname(savedPath), { recursive: true });
        fs.copyFileSync(outputPath, savedPath);
      }
      return renderResult(
        savedPath
          ? `Rendered for inspection. Saved to ${savedPath} — embed it with ![[${path.basename(savedPath)}]] if you want the note to reference the file.`
          : "Rendered for inspection (not saved). Pass savePath to keep the file.",
        { ok: true, render: true, savedPath },
        { type: "image", data, mimeType: "image/png" },
      );
    },
  });
};

/**
 * tutor-mode — 让 tutor 专属工具只在 tutor 会话里对模型可见。
 *
 * 扩展加载时注册的工具会被 pi 默认全部放进 active tools，于是普通 dev 会话里
 * 模型也会看到 ask_user_question 并拿它当通用提问工具。这里用 `setActiveTools`
 * 把它们从"喂给 provider 的工具定义"里摘掉，判定全在 mode-core（纯函数）。
 *
 * 五个入口：before_agent_start（正常一轮，同轮生效）、input（流式 steer 不经过
 * before_agent_start）、session_start（resume / reload 恢复）、/tutor-mode（人敲）、
 * 以及 notes-store 的绑定回调（绑了 vault 内的笔记 = 教学会话）。
 */
const registerTutorMode = (
  pi: ExtensionAPI,
): {
  /** 绑定教学内容后开闸门（notes-store 的 onBindingChange 调它）。 */
  enable: () => void;
} => {
  let mode: TutorMode = "off";

  const sync = (): void => {
    const plan = planToolSync(pi.getActiveTools(), mode);
    if (plan.changed) pi.setActiveTools(plan.tools);
  };

  /** 状态只在翻转时落条目 + sync（人敲命令也算翻转）。 */
  const setMode = (next: TutorMode, persist: boolean): void => {
    if (mode === next) return;
    mode = next;
    if (persist) {
      pi.appendEntry(TUTOR_MODE_ENTRY_TYPE, { active: next === "on" });
    }
    sync();
  };

  /** 教学内容区（`<vaultRoot>/<topDir>`）：只有落在这里的绑定才算教学会话。 */
  const vaultDir = (cwd: string | undefined): string | undefined =>
    cwd === undefined ? undefined : vaultDirOf(resolveSettings({ cwd }));

  pi.on("session_start", async (_event, ctx) => {
    mode = restoreTutorMode(ctx.sessionManager.getEntries(), {
      vaultDir: vaultDir(ctx.cwd),
    });
    sync();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const skill = detectTutorSkill(event.prompt);
    if (skill) setMode("on", true);
    else {
      // 每轮按会话事实重新推导：绑定 / 解绑都落在 `tutor-notes` 条目里，
      // 所以 /md-unlog 不需要额外的「关闸」指令，下一轮就按事实回到 off。
      setMode(
        restoreTutorMode(ctx.sessionManager.getEntries(), {
          vaultDir: vaultDir(ctx.cwd),
        }),
        false,
      );
    }
    sync();
  });

  // 流式中途的 /skill:tutor（steer / followUp）不触发 before_agent_start，
  // 只有 input 事件看得到那段还没展开的原始命令。普通输入交给上面那条更权威的路径。
  pi.on("input", async (event) => {
    if (!event.streamingBehavior) return;
    if (detectTutorCommand(event.text)) setMode("on", true);
  });

  pi.registerCommand(TUTOR_MODE_COMMAND_NAME, {
    description:
      "Tutor 会话开关：on | off | status（tutor 专属工具是否对模型可见）",
    handler: async (args, ctx) => {
      const decision = parseTutorModeCommand(args);
      if (decision.kind === "invalid") {
        ctx.ui.notify(`未知参数：${decision.value}`, "warning");
        return;
      }
      if (decision.kind !== "status") setMode(decision.kind, true);
      sync();
      ctx.ui.notify(formatTutorModeStatus(mode, pi.getActiveTools()));
    },
  });

  // 绑定的会话事实本身就是持久信号（`tutor-notes` 条目），不再另写一条 tutor-mode：
  // 否则解绑后会被那条显式条目钉在 on，而显式条目的优先级高于绑定。
  return { enable: () => setMode("on", false) };
};

export default function tutorExtension(pi: ExtensionAPI): void {
  // 顺序有意：mode 控制器要先跑并交出 enable（notes-store 绑定后要用它开闸门）。
  const tutorMode = registerTutorMode(pi);
  registerQuiz(pi);
  registerAsk(pi);
  registerNotes(pi, {
    onBindingChange: ({ inVault }) => {
      if (inVault) tutorMode.enable();
    },
  });
  registerConcepts(pi);
  registerTopicStatus(pi);
  registerDiagram(pi);
}
