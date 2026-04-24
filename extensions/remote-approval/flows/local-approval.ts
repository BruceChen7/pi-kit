import type { ApprovalDecision } from "./approval.ts";

type LocalApprovalContext = {
  hasUI: boolean;
  ui: {
    select?: (title: string, options: string[]) => Promise<string | undefined>;
  };
};

type LocalApprovalInput = {
  toolName: string;
  title: string;
  preview: string;
  contextPreview: string[];
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

export const requestLocalApproval = async (
  ctx: LocalApprovalContext,
  input: LocalApprovalInput,
): Promise<ApprovalDecision> => {
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
