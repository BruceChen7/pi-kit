import type { ApprovalDecision } from "./approval.ts";

type LocalApprovalContext = {
  hasUI: boolean;
  ui: {
    custom?: <T>(
      builder: (
        tui: { requestRender?: () => void },
        theme: {
          fg: (color: string, text: string) => string;
          bg: (color: string, text: string) => string;
          bold: (text: string) => string;
        },
        keybindings: unknown,
        done: (result: T) => void,
      ) => {
        render: (width?: number) => string[];
        handleInput: (input: string) => void;
      },
      options?: { overlay?: boolean },
    ) => Promise<T | undefined>;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  };
};

type LocalApprovalInput = {
  toolName: string;
  title: string;
  preview: string;
  contextPreview: string[];
};

const OPTIONS: ApprovalDecision[] = ["allow", "always", "deny"];
const LABELS: Record<ApprovalDecision, string> = {
  allow: "Allow",
  always: "Always",
  deny: "Deny",
};

const mapSelection = (
  value: string | ApprovalDecision | undefined,
): ApprovalDecision => {
  switch (value) {
    case "always":
    case "Always":
      return "always";
    case "deny":
    case "Deny":
      return "deny";
    default:
      return "allow";
  }
};

const isEnter = (input: string): boolean =>
  input === "\r" || input === "\n" || input === "return";

const isEscape = (input: string): boolean =>
  input === "\u001b" || input === "escape";

const moveSelection = (
  current: number,
  delta: number,
  total: number,
): number => {
  const next = current + delta;
  if (next < 0) {
    return 0;
  }
  if (next >= total) {
    return total - 1;
  }
  return next;
};

export const requestLocalApproval = async (
  ctx: LocalApprovalContext,
  input: LocalApprovalInput,
): Promise<ApprovalDecision> => {
  if (ctx.hasUI && typeof ctx.ui.custom === "function") {
    const decision = await ctx.ui.custom<ApprovalDecision>(
      (tui, theme, _keybindings, done) => {
        let selected = 0;

        return {
          render: () => {
            const lines = [theme.bold(input.title), "", input.preview];
            if (input.contextPreview.length > 0) {
              lines.push("", ...input.contextPreview);
            }
            lines.push("");
            for (let i = 0; i < OPTIONS.length; i++) {
              const option = OPTIONS[i];
              const prefix = i === selected ? "> " : "  ";
              const line = `${prefix}${i + 1}. ${LABELS[option]}`;
              lines.push(i === selected ? theme.fg("accent", line) : line);
            }
            lines.push(
              "",
              "Enter confirm • Esc deny • ↑↓ move • 1/2/3 quick select",
            );
            return lines;
          },
          handleInput: (rawInput: string) => {
            if (rawInput === "1" || rawInput === "2" || rawInput === "3") {
              done(OPTIONS[Number.parseInt(rawInput, 10) - 1]);
              return;
            }
            if (rawInput === "up" || rawInput === "k") {
              selected = moveSelection(selected, -1, OPTIONS.length);
              tui.requestRender?.();
              return;
            }
            if (rawInput === "down" || rawInput === "j") {
              selected = moveSelection(selected, 1, OPTIONS.length);
              tui.requestRender?.();
              return;
            }
            if (isEnter(rawInput)) {
              done(OPTIONS[selected]);
              return;
            }
            if (isEscape(rawInput)) {
              done("deny");
            }
          },
        };
      },
      { overlay: true },
    );
    return mapSelection(decision);
  }

  if (ctx.hasUI && typeof ctx.ui.select === "function") {
    const selection = await ctx.ui.select(input.title, [
      "Allow",
      "Always",
      "Deny",
    ]);
    return mapSelection(selection);
  }

  return "allow";
};
